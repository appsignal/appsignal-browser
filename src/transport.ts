import type { EventPayload, FrontendTransaction, ReplayChunk } from "./types.js";

let baseEndpoint = "";
let ingestionKey = "";

// Errors POST as FrontendTransaction JSON to /ingest/browser/errors and
// route through the processor's frontend_errors pipeline (sourcemap
// resolution + incidents). Periodic events (breadcrumbs + web vitals) POST
// to /ingest/browser as an `events` payload; the body is JSON but sent with
// a text/plain content type so cross-origin sendBeacon doesn't trip a CORS
// preflight (the server reads the raw bytes regardless).
const EVENTS_PATH = "/ingest/browser";
const ERROR_PATH = "/ingest/browser/errors";

type Kind = "events" | "error";

// Chromium-enforced cap on `sendBeacon` bodies. `fetch({keepalive:true})`
// shares the same cap, so there is no point falling back to keepalive for
// larger payloads — the browser rejects both silently. Small payloads
// survive unload via beacon. Larger ones are dropped: the lost data is
// whatever accumulated since the last periodic flush (each flush drains
// the buffer), so bound is ≤5 s of replay events or ≤30 s of breadcrumbs.
const BEACON_MAX_BYTES = 64 * 1024;
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
    clearTimeout(retryDrainTimer);
    retryDrainTimer = null;
  }
  for (const t of pendingRetries) clearTimeout(t);
  pendingRetries.clear();
  if (listeningForOnline) {
    window.removeEventListener("online", flushOnline);
    listeningForOnline = false;
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
  // Errors go through the legacy frontend_errors pipeline which parses the
  // body as JSON; events ride a CORS-preflight-free text/plain channel.
  return kind === "error" ? "application/json" : "text/plain";
}

export function sendError(payload: FrontendTransaction): void {
  const body = JSON.stringify(payload);
  // Mid-unload (visibility hidden), the fetch is at risk of cancellation —
  // navigating away aborts in-flight requests. sendBeacon survives unload.
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    flushOnUnload(body, "error");
    return;
  }
  send(body, "error");
}

export function sendEvents(payload: EventPayload): void {
  send(JSON.stringify(payload), "events");
}

export function sendReplayChunk(payload: ReplayChunk, useBeacon = false): void {
  const body = JSON.stringify(payload);
  if (useBeacon) {
    flushOnUnload(body, "events");
  } else {
    send(body, "events");
  }
}

/** Flush events via sendBeacon for pagehide/visibility-hidden. Bodies larger
 * than the beacon cap are dropped rather than attempted — the keepalive fetch
 * fallback shares the same cap and silently rejects oversize bodies anyway. */
export function sendBeaconEvents(payload: EventPayload): void {
  flushOnUnload(JSON.stringify(payload), "events");
}

/** Send a payload during page unload using sendBeacon. Bounded to
 * BEACON_MAX_BYTES: larger bodies are dropped because both sendBeacon and
 * fetch({keepalive:true}) silently reject them. The dropped payload is
 * whatever accumulated since the last periodic flush — bounded by the
 * flush cadence (5 s replay / 30 s events). */
function flushOnUnload(body: string, kind: Kind): void {
  if (!navigator.onLine) {
    enqueue(body, kind);
    return;
  }

  if (typeof navigator.sendBeacon !== "function") return;
  if (body.length > BEACON_MAX_BYTES) return;

  // application/json triggers a CORS preflight in cross-origin sendBeacon
  // calls, which the spec disallows — for same-origin /ingest/browser this
  // works because no preflight is needed. The server accepts application/json
  // on both fetch and beacon paths.
  const blob = new Blob([body], { type: contentTypeFor(kind) });
  navigator.sendBeacon(urlFor(kind), blob);
}

function send(body: string, kind: Kind): void {
  // Drop payloads that exceed the size limit
  if (body.length > MAX_PAYLOAD_BYTES) return;

  if (!navigator.onLine) {
    enqueue(body, kind);
    return;
  }
  doFetch(body, 0, kind);
}

function enqueue(body: string, kind: Kind): void {
  // A single body that already exceeds the cap can't ever fit; drop it
  // rather than evicting everything else trying to make room.
  if (body.length > MAX_QUEUE_BYTES) return;
  // Evict oldest entries until the new body fits under the byte cap.
  while (retryQueue.length > 0 && retryQueueBytes + body.length > MAX_QUEUE_BYTES) {
    const dropped = retryQueue.shift()!;
    retryQueueBytes -= dropped.body.length;
  }
  retryQueue.push({ body, kind });
  retryQueueBytes += body.length;
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
