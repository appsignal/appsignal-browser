import type { ServerConfig } from "./types.js";
import { getSessionId, getTabId } from "./session.js";
import { sendReplayChunk } from "./transport.js";
import { getConsent, onConsentDenied, onConsentGranted } from "./consent.js";
import { onBeforeNavigation } from "./breadcrumbs.js";
import { storage, seededRandom } from "./utils.js";
import { onVisibilityChange, onPageHide } from "./lifecycle.js";
import { onErrorReported } from "./errors.js";

let config: ServerConfig["replay"];
let appVersion: string | undefined;
let recorder: { stop: () => void } | null = null;
let isRecording = false;
let isPaused = false;
let sessionRandom = 0;
let sampled = true;
let errorReplayEnabled = false;
let hadError = false;
// Holds rrweb events since the most recent FullSnapshot. Capped naturally by
// CHECKOUT_INTERVAL_MS — on every checkout the buffer is reset (and either
// shipped, for sampled sessions, or dropped, for unsampled ones). Anything
// older than the last checkout is unrenderable on the server because the
// FullSnapshot it depended on is gone, so there's no value in keeping it.
let eventBuffer: unknown[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let maxRecordingTimer: ReturnType<typeof setTimeout> | null = null;
let errorReplayTimer: ReturnType<typeof setTimeout> | null = null;
let recordFn: ((opts: Record<string, unknown>) => (() => void) | undefined) | null = null;
let lifecycleUnsubscribers: (() => void)[] = [];
let listenersRegistered = false;

// Implementation details, not server-tunable. The pre-error window the
// unsampled+error_replay path captures is implicitly equal to
// CHECKOUT_INTERVAL_MS (the buffer holds events since the latest FullSnapshot).
// POST_ERROR_TAIL_MS is how long we keep shipping after an error so the
// immediate user reaction lands in the replay too.
const CHECKOUT_INTERVAL_MS = 60_000;
const POST_ERROR_TAIL_MS = 5_000;
const FLUSH_INTERVAL_MS = 5_000;

const chunkIndexKey = (sessionId: string, tabId: string) =>
  `appsignal_replay_chunk_index_${sessionId}_${tabId}`;

function nextChunkIndex(sessionId: string, tabId: string): number {
  const key = chunkIndexKey(sessionId, tabId);
  const current = Number(storage.getString(sessionStorage, key) || "0");
  storage.setString(sessionStorage, key, String(current + 1));
  return current;
}

/** Clear chunk counter on session end so keys don't pile up in long-lived tabs. */
export function clearChunkIndex(sessionId: string, tabId: string): void {
  storage.remove(sessionStorage, chunkIndexKey(sessionId, tabId));
}

export function initReplay(
  serverConfig: ServerConfig["replay"],
  version?: string,
): void {
  config = serverConfig;
  appVersion = version;

  if (!config.enabled) return;

  // Sampling roll, narrowed by applyReplaySampling() when server config arrives.
  sessionRandom = seededRandom(getSessionId());
  sampled = sessionRandom < config.sample_rate;

  if (sampled && getConsent() === "granted") {
    startRecording();
  }

  // Register listeners only once — prevents accumulation on init→destroy→init cycles
  if (!listenersRegistered) {
    listenersRegistered = true;

    // Flush replay on SPA navigation so each page gets its own chunk
    onBeforeNavigation(() => {
      if (isRecording) flushChunk();
    });

    window.addEventListener("offline", pauseRecording);
    window.addEventListener("online", resumeRecording);

    // Flush on page hide — use beacon so the request survives unload.
    // Plain fetch is cancelled mid-flight on unload, which drops the
    // first chunk (the one with rrweb's initial FullSnapshot).
    lifecycleUnsubscribers.push(
      onVisibilityChange((state) => {
        if (state === "hidden" && isRecording) flushChunk(true);
      }),
    );
    lifecycleUnsubscribers.push(
      onPageHide((persisted) => {
        if (!persisted && isRecording) flushChunk(true);
      }),
    );

    onConsentDenied(() => {
      if (isRecording) stopReplay();
    });
    onConsentGranted(() => {
      if (sampled && !isRecording && !isPaused) {
        startRecording();
      }
    });

    // Trigger the post-error tail only for errors that actually shipped —
    // errors.ts publishes after beforeSend approval, so dropped errors don't
    // open the window.
    lifecycleUnsubscribers.push(onErrorReported(() => onError()));
  }
}

/** Apply the real sampling decision once server config is available. */
export function applyReplaySampling(realConfig: ServerConfig["replay"]): void {
  config = realConfig;

  if (!realConfig.enabled) {
    discardReplay();
    return;
  }

  sampled = sessionRandom < realConfig.sample_rate;
  errorReplayEnabled = realConfig.error_replay;

  if (!sampled && !errorReplayEnabled) {
    discardReplay();
  }
}

export function onError(): void {
  // Each error opens a single fixed window: ship the current pre-error
  // buffer immediately, plus POST_ERROR_TAIL_MS of subsequent activity.
  // Errors that fire while a tail is still active are absorbed — they
  // don't extend or re-trigger the window. This keeps the per-session
  // upload bounded even for cascading errors; the in-flight tail already
  // captures the immediate aftermath.
  if (errorReplayTimer !== null) return;
  hadError = true;
  errorReplayTimer = setTimeout(() => {
    hadError = false;
    errorReplayTimer = null;
  }, POST_ERROR_TAIL_MS);
  flushChunk();
}

async function startRecording(): Promise<void> {
  if (isRecording) return;

  try {
    if (!recordFn) {
      const mod = await import("@rrweb/record");
      recordFn = mod.record as unknown as typeof recordFn;
    }

    const stopFn = recordFn!({
      emit: (event: unknown, isCheckout?: boolean) => {
        if (isCheckout) {
          // rrweb is about to push a fresh FullSnapshot. The previous
          // chunk's events are still anchored on the *old* FullSnapshot;
          // for sampled sessions we ship them now (one chunk per checkout
          // window). For unsampled sessions the previous events are
          // unrenderable without the old snapshot we're about to lose, so
          // we drop them — the replay starts fresh from this checkout.
          if (sampled && eventBuffer.length > 0) {
            flushChunk();
          } else {
            eventBuffer = [];
          }
        }
        eventBuffer.push(event);
      },
      checkoutEveryNms: CHECKOUT_INTERVAL_MS,
      maskAllInputs: config.mask_all_inputs,
      maskTextSelector: config.mask_selectors.length
        ? config.mask_selectors.join(", ")
        : undefined,
      blockSelector: config.block_selectors.length
        ? config.block_selectors.join(", ")
        : undefined,
    });

    if (stopFn) {
      recorder = { stop: stopFn as () => void };
    }
    isRecording = true;
    isPaused = false;

    flushTimer = setInterval(flushChunk, FLUSH_INTERVAL_MS);

    // Clear any existing timeout from a previous start (pause→resume)
    if (maxRecordingTimer) clearTimeout(maxRecordingTimer);
    maxRecordingTimer = setTimeout(() => stopReplay(), config.max_duration_ms);
  } catch {
    // rrweb not available — skip silently
  }
}

function pauseRecording(): void {
  if (!isRecording) return;

  clearTimers();
  flushChunk();
  if (recorder) {
    recorder.stop();
    recorder = null;
  }
  isRecording = false;
  isPaused = true;
}

function resumeRecording(): void {
  if (!isPaused) return;
  isPaused = false;

  // Restart recording — rrweb takes a fresh full snapshot
  startRecording();
}

function flushChunk(useBeacon = false): void {
  if (eventBuffer.length === 0) return;

  // Only send if sampled, or if error_replay triggered by an error
  if (!sampled && !(errorReplayEnabled && hadError)) return;

  const events = eventBuffer;
  eventBuffer = [];

  const sessionId = getSessionId();
  const tabId = getTabId();
  sendReplayChunk(
    {
      type: "replay",
      session_id: sessionId,
      tab_id: tabId,
      chunk_index: nextChunkIndex(sessionId, tabId),
      events,
      app_version: appVersion,
    },
    useBeacon,
  );
}

function clearTimers(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  if (maxRecordingTimer) {
    clearTimeout(maxRecordingTimer);
    maxRecordingTimer = null;
  }
  if (errorReplayTimer) {
    clearTimeout(errorReplayTimer);
    errorReplayTimer = null;
  }
}

export function stopReplay(): void {
  clearTimers();
  flushChunk();
  if (recorder) {
    recorder.stop();
    recorder = null;
  }
  isRecording = false;
  isPaused = false;
}

/** Flush buffered replay under the current session without stopping the recorder.
 * Pass `useBeacon=true` when a navigation is imminent (e.g. logout). */
export function flushReplay(useBeacon = false): void {
  if (isRecording) flushChunk(useBeacon);
}

export function destroyReplay(): void {
  stopReplay();
  window.removeEventListener("offline", pauseRecording);
  window.removeEventListener("online", resumeRecording);
  for (const unsub of lifecycleUnsubscribers) unsub();
  lifecycleUnsubscribers = [];
  hadError = false;
  listenersRegistered = false;
}

/** Stop recording and discard buffered data without flushing. */
export function discardReplay(): void {
  clearTimers();
  eventBuffer = [];
  if (recorder) {
    recorder.stop();
    recorder = null;
  }
  isRecording = false;
  isPaused = false;
}
