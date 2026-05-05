import type { BrowserError, EventPayload, ReplayChunk } from "./types.js";
import { getConsent, onConsentGranted, onConsentDenied } from "./consent.js";

let endpoint = "";
let ingestionKey = "";

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
const MAX_QUEUE_SIZE = 100;

// Queued payloads — covers three cases: offline, pending consent, and
// payloads whose in-line retries were exhausted on 429/5xx or network error.
let retryQueue: string[] = [];
let listeningForOnline = false;
// Pending in-line retry setTimeouts. Tracked so destroyTransport() can
// cancel them instead of letting a stray fetch fire against a torn-down SDK.
const pendingRetries = new Set<ReturnType<typeof setTimeout>>();

export function initTransport(ep: string, key: string): void {
  endpoint = ep;
  ingestionKey = key;

  // When consent is granted, flush queued payloads
  onConsentGranted(() => {
    drainQueue();
  });

  // When consent is denied, drop all queued payloads
  onConsentDenied(() => {
    retryQueue = [];
  });
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
  endpoint = "";
  ingestionKey = "";
}

export function sendError(payload: BrowserError): void {
  send(JSON.stringify(payload));
}

export function sendEvents(payload: EventPayload): void {
  send(JSON.stringify(payload));
}

export function sendReplayChunk(payload: ReplayChunk, useBeacon = false): void {
  const body = JSON.stringify(payload);
  if (useBeacon) {
    flushOnUnload(body);
  } else {
    send(body);
  }
}

/** Flush events via sendBeacon for pagehide/visibility-hidden. Bodies larger
 * than the beacon cap are dropped rather than attempted — the keepalive fetch
 * fallback shares the same cap and silently rejects oversize bodies anyway. */
export function sendBeaconEvents(payload: EventPayload): void {
  flushOnUnload(JSON.stringify(payload));
}

/** Send a payload during page unload using sendBeacon. Bounded to
 * BEACON_MAX_BYTES: larger bodies are dropped because both sendBeacon and
 * fetch({keepalive:true}) silently reject them. The dropped payload is
 * whatever accumulated since the last periodic flush — bounded by the
 * flush cadence (5 s replay / 30 s events). */
function flushOnUnload(body: string): void {
  const consent = getConsent();
  if (consent === "not-granted") return;

  if (consent === "pending" || !navigator.onLine) {
    enqueue(body);
    return;
  }

  if (typeof navigator.sendBeacon !== "function") return;
  if (body.length > BEACON_MAX_BYTES) return;

  const url = `${endpoint}?key=${encodeURIComponent(ingestionKey)}`;
  const blob = new Blob([body], { type: "text/plain" });
  navigator.sendBeacon(url, blob);
}

function send(body: string): void {
  const consent = getConsent();
  if (consent === "not-granted") return;

  // Drop payloads that exceed the size limit
  if (body.length > MAX_PAYLOAD_BYTES) return;

  if (consent === "pending" || !navigator.onLine) {
    enqueue(body);
    return;
  }
  doFetch(body, 0);
}

function enqueue(body: string): void {
  if (retryQueue.length >= MAX_QUEUE_SIZE) {
    retryQueue.shift();
  }
  retryQueue.push(body);
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
  if (getConsent() !== "granted") return;
  const items = retryQueue.splice(0);
  for (const body of items) {
    doFetch(body, 0);
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

function doFetch(body: string, attempt: number): void {
  // destroyTransport() clears endpoint — bail out rather than fire a stray
  // fetch at the current origin with an empty key.
  if (endpoint === "") return;
  const url = `${endpoint}?key=${encodeURIComponent(ingestionKey)}`;
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body,
  })
    .then((response) => {
      if (response.ok) return;

      if (response.status === 429 || response.status >= 500) {
        if (attempt < MAX_RETRIES) {
          scheduleRetry(body, attempt + 1, response.status === 429);
        } else {
          // Out of in-line retries but server may recover — hand off to the
          // retry queue so we don't drop replay chunks on transient outages.
          enqueue(body);
        }
      }
      // 4xx (except 429): drop — client error, retrying won't help
    })
    .catch(() => {
      if (!navigator.onLine) {
        enqueue(body);
      } else if (attempt < MAX_RETRIES) {
        scheduleRetry(body, attempt + 1, false);
      } else {
        enqueue(body);
      }
    });
}

function scheduleRetry(body: string, attempt: number, is429: boolean): void {
  const timer = setTimeout(() => {
    pendingRetries.delete(timer);
    doFetch(body, attempt);
  }, retryDelay(attempt - 1, is429));
  pendingRetries.add(timer);
}
