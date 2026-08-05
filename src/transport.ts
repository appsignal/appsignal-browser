import type { EventPayload, FrontendTransaction, PageLoadPayload, ReplayChunk } from "./types.js";
import { logError, attemptCleanup } from "./utils.js";

let baseEndpoint = "";
let ingestionKey = "";

// Errors POST as FrontendTransaction JSON to /ingest/browser/errors and
// route through the processor's frontend_errors pipeline (sourcemap
// resolution + incidents). Periodic events (breadcrumbs + web vitals) POST
// to /ingest/browser as an `events` payload; the body is JSON but sent with
// a text/plain content type so cross-origin sendBeacon doesn't trip a CORS
// preflight (the server reads the raw bytes regardless).
export const EVENTS_PATH = "/ingest/browser";
export const ERROR_PATH = "/ingest/browser/errors";

type Kind = "events" | "error";

// Chromium-enforced cap on `sendBeacon` bodies. `fetch({keepalive:true})` has
// the same cap, so a fallback to keepalive gives nothing. A body over the cap
// goes to the retry queue.
const BEACON_MAX_BYTES = 64 * 1024;
// The only Content-Type a beacon can carry cross-origin. See flushOnUnload.
const BEACON_CONTENT_TYPE = "text/plain";
// Match the server's DefaultBodyLimit in crates/ingest/src/lib.rs. Replay
// FullSnapshot chunks for rich DOMs routinely exceed 512 KB; dropping them
// client-side left sessions with no initial snapshot and unplayable replays.
const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_RETRIES = 3;
const BASE_RETRY_MS = 1000;
// Byte-bounded queue. Per-payload limit is 10 MB (MAX_PAYLOAD_BYTES); a
// count-based cap of 100 would let an offline tab pin ~1 GB of replay
// chunks. 32 MB still holds many normal-sized chunks (~50–500 KB each)
// while bounding worst-case memory.
const MAX_QUEUE_BYTES = 32 * 1024 * 1024;

interface Queued { body: string; kind: Kind; }

// Queued payloads — covers offline plus payloads whose in-line retries
// were exhausted on 429/5xx or network error.
let retryQueue: Queued[] = [];
let retryQueueBytes = 0;
let listeningForOnline = false;
// Pending in-line retry setTimeouts. Tracked so destroyTransport() can
// cancel them instead of letting a stray fetch fire against a torn-down SDK.
const pendingRetries = new Set<ReturnType<typeof setTimeout>>();

/** Configure transport. `endpoint` is the BASE origin (no path) — paths and
 * query params are appended internally per payload kind. */
export function initTransport(endpoint: string, key: string): void {
  baseEndpoint = endpoint.replace(/\/$/, "");
  ingestionKey = key;
}

/** Stop the periodic retry drain, cancel in-flight retry timers, and detach
 * the online-event listener. Called from destroy(). Resets endpoint/key so
 * any stray handler firing post-destroy fails closed. */
export function destroyTransport(): void {
  if (retryDrainTimer) {
    const timer = retryDrainTimer;
    retryDrainTimer = null;
    attemptCleanup("retry drain timer", () => clearTimeout(timer));
  }
  for (const t of pendingRetries) attemptCleanup("retry timer", () => clearTimeout(t));
  pendingRetries.clear();
  if (listeningForOnline) {
    listeningForOnline = false;
    attemptCleanup("online listener", () => window.removeEventListener("online", flushOnline));
  }
  retryQueue = [];
  retryQueueBytes = 0;
  baseEndpoint = "";
  ingestionKey = "";
}

function urlFor(kind: Kind): string {
  const path = kind === "error" ? ERROR_PATH : EVENTS_PATH;
  return `${baseEndpoint}${path}?api_key=${encodeURIComponent(ingestionKey)}`;
}

function contentTypeFor(kind: Kind): string {
  // For the fetch path only. The beacon path always uses BEACON_CONTENT_TYPE.
  // Errors go through the legacy frontend_errors pipeline which parses the
  // body as JSON; events ride a CORS-preflight-free text/plain channel.
  return kind === "error" ? "application/json" : "text/plain";
}

/** Bytes, not `String.length`: a 3-byte character counts as one UTF-16 unit,
 * so a length check passes a body three times the limit. */
function byteSize(body: string): number {
  return new Blob([body]).size;
}

/** Serialize a payload without letting the failure reach host code. `pruneForJson`
 * prunes host values at capture, so a throw here means one got past it. A
 * dropped payload is bad. A throw out of `sendError` into the caller of
 * `captureError` is worse. */
function serialize(payload: unknown): string | null {
  try {
    return JSON.stringify(payload);
  } catch (error) {
    logError("payload could not be serialized; dropped", error);
    return null;
  }
}

export function sendError(payload: FrontendTransaction): void {
  const body = serialize(payload);
  // Mid-unload (visibility hidden), the fetch is at risk of cancellation —
  // navigating away aborts in-flight requests. sendBeacon survives unload.
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    flushOnUnload(body, "error");
    return;
  }
  send(body, "error");
}

export function sendEvents(payload: EventPayload): void {
  send(serialize(payload), "events");
}

/** Declare a navigation's page load span. Rides the same `/ingest/browser`
 * channel as the events payload, distinguished by its `type`. */
export function sendPageLoad(payload: PageLoadPayload): void {
  send(serialize(payload), "events");
}

export function sendReplayChunk(payload: ReplayChunk, useBeacon = false): void {
  const body = serialize(payload);
  if (useBeacon) {
    flushOnUnload(body, "events");
  } else {
    send(body, "events");
  }
}

/** Flush events via sendBeacon for pagehide/visibility-hidden. A body over the
 * beacon cap goes to the retry queue. */
export function sendBeaconEvents(payload: EventPayload): void {
  flushOnUnload(serialize(payload), "events");
}

/** Send during unload via sendBeacon. What the beacon cannot take goes to the
 * retry queue, which only helps a tab that is hidden but still alive. */
function flushOnUnload(body: string | null, kind: Kind): void {
  if (body === null) return;
  if (!navigator.onLine) {
    enqueue(body, kind);
    return;
  }

  // A hidden tab is often still alive, so the queue gets another chance.
  if (typeof navigator.sendBeacon !== "function") {
    enqueue(body, kind);
    return;
  }
  if (byteSize(body) > BEACON_MAX_BYTES) {
    // Over the fetch limit it would 413, and a 4xx is dropped, so queueing it
    // would only evict payloads that can still go.
    if (byteSize(body) <= MAX_PAYLOAD_BYTES) enqueue(body, kind);
    return;
  }

  // A beacon is always credentialed, so a type that is not CORS-safelisted
  // makes it a CORS request that a wildcard ACAO rejects. It fails silently:
  // sendBeacon still returns true. The endpoint reads the body raw.
  const blob = new Blob([body], { type: BEACON_CONTENT_TYPE });
  // false means the user agent refused to queue it, not that it failed to send.
  if (!navigator.sendBeacon(urlFor(kind), blob)) enqueue(body, kind);
}

function send(body: string | null, kind: Kind): void {
  if (body === null) return;
  // Drop payloads that exceed the size limit
  if (byteSize(body) > MAX_PAYLOAD_BYTES) return;

  if (!navigator.onLine) {
    enqueue(body, kind);
    return;
  }
  doFetch(body, 0, kind);
}

function enqueue(body: string, kind: Kind): void {
  // A single body that already exceeds the cap can't ever fit; drop it
  // rather than evicting everything else trying to make room.
  const bytes = byteSize(body);
  if (bytes > MAX_QUEUE_BYTES) return;
  // Evict oldest entries until the new body fits under the byte cap.
  while (retryQueue.length > 0 && retryQueueBytes + bytes > MAX_QUEUE_BYTES) {
    const dropped = retryQueue.shift()!;
    retryQueueBytes -= byteSize(dropped.body);
  }
  retryQueue.push({ body, kind });
  retryQueueBytes += bytes;
  startOnlineListener();
  scheduleRetryDrain();
}

function startOnlineListener(): void {
  if (listeningForOnline) return;
  listeningForOnline = true;
  window.addEventListener("online", flushOnline, { once: true });
}

function flushOnline(): void {
  listeningForOnline = false;
  drainQueue();
}

// Periodic drain so queued payloads recover from server outages that
// don't trigger an `online` event (e.g. a container restart while the
// browser's network stayed up).
const RETRY_DRAIN_INTERVAL_MS = 30_000;
let retryDrainTimer: ReturnType<typeof setTimeout> | null = null;

// Schedules a single 30 s timer when called, no-ops if one is already pending.
// The timer self-arms only if the queue is still non-empty after the drain;
// otherwise it stops. New enqueues call back into scheduleRetryDrain() so the
// timer restarts whenever fresh retry work appears.
function scheduleRetryDrain(): void {
  if (retryDrainTimer) return;
  retryDrainTimer = setTimeout(() => {
    retryDrainTimer = null;
    if (retryQueue.length === 0) return;
    if (navigator.onLine) drainQueue();
    if (retryQueue.length > 0) scheduleRetryDrain();
  }, RETRY_DRAIN_INTERVAL_MS);
}

function drainQueue(): void {
  const items = retryQueue.splice(0);
  retryQueueBytes = 0;
  for (const item of items) {
    doFetch(item.body, 0, item.kind);
  }
}

function retryDelay(attempt: number, is429: boolean): number {
  // 429: longer backoff (5s, 10s, 20s)
  // 5xx/network: exponential (1s, 2s, 4s) with jitter
  const base = is429 ? 5000 : BASE_RETRY_MS;
  const delay = base * Math.pow(2, attempt);
  const jitter = delay * 0.2 * Math.random();
  return delay + jitter;
}

function doFetch(body: string, attempt: number, kind: Kind): void {
  // destroyTransport() clears the base endpoint — bail out rather than fire
  // a stray fetch at the current origin with an empty key.
  if (baseEndpoint === "") return;
  fetch(urlFor(kind), {
    method: "POST",
    headers: { "Content-Type": contentTypeFor(kind) },
    body,
  })
    .then((response) => {
      if (response.ok) return;

      if (response.status === 429 || response.status >= 500) {
        if (attempt < MAX_RETRIES) {
          scheduleRetry(body, attempt + 1, response.status === 429, kind);
        } else {
          // Out of in-line retries but server may recover — hand off to the
          // retry queue so we don't drop replay chunks on transient outages.
          enqueue(body, kind);
        }
      }
      // 4xx (except 429): drop — client error, retrying won't help
    })
    .catch(() => {
      if (!navigator.onLine) {
        enqueue(body, kind);
      } else if (attempt < MAX_RETRIES) {
        scheduleRetry(body, attempt + 1, false, kind);
      } else {
        enqueue(body, kind);
      }
    });
}

function scheduleRetry(body: string, attempt: number, is429: boolean, kind: Kind): void {
  const timer = setTimeout(() => {
    pendingRetries.delete(timer);
    doFetch(body, attempt, kind);
  }, retryDelay(attempt - 1, is429));
  pendingRetries.add(timer);
}
