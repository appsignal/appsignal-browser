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
let eventBuffer: unknown[] = [];
let eventSizes: number[] = [];
let totalMemoryBytes = 0;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let maxRecordingTimer: ReturnType<typeof setTimeout> | null = null;
let errorReplayTimer: ReturnType<typeof setTimeout> | null = null;
let recordFn: ((opts: Record<string, unknown>) => (() => void) | undefined) | null = null;
let lifecycleUnsubscribers: (() => void)[] = [];
let listenersRegistered = false;

const MAX_MEMORY_BYTES = 50 * 1024 * 1024; // 50 MB

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
  // Sliding window: each error extends the post-error ship window. Without
  // resetting hadError, a single error early in the session would cause every
  // subsequent flush to ship for hours. Window length is server-tunable via
  // replay.after_error_replay_window_ms.
  hadError = true;
  if (errorReplayTimer) clearTimeout(errorReplayTimer);
  errorReplayTimer = setTimeout(() => {
    hadError = false;
    errorReplayTimer = null;
  }, config.after_error_replay_window_ms);
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
        // Flush before a new full snapshot so each chunk starts clean
        if (isCheckout && eventBuffer.length > 0) {
          flushChunk();
        }

        let size: number;
        try { size = JSON.stringify(event).length; }
        catch { size = 1024; }
        totalMemoryBytes += size;

        while (eventBuffer.length > 0 && totalMemoryBytes > MAX_MEMORY_BYTES) {
          eventBuffer.shift();
          const removed = eventSizes.shift();
          if (removed !== undefined) totalMemoryBytes -= removed;
        }

        eventBuffer.push(event);
        eventSizes.push(size);
      },
      checkoutEveryNms: config.checkout_interval_ms || undefined,
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

    flushTimer = setInterval(flushChunk, 5000);

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
  eventSizes = [];
  totalMemoryBytes = 0;

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
  eventSizes = [];
  totalMemoryBytes = 0;
  if (recorder) {
    recorder.stop();
    recorder = null;
  }
  isRecording = false;
  isPaused = false;
}
