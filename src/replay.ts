// Session replay module — preserved in the repo for v2+ but NOT imported by
// index.ts in v1, so esbuild tree-shakes it out of both bundles and rrweb
// is never downloaded. The implementation stays here so the tests below
// keep documenting the contract and the file is ready to re-wire when
// replay's storage path is in place.

import type { ReplayConfig, ReplayPrivacyDom } from "./types.js";
import { getSessionId, getTabId } from "./session.js";
import { sendReplayChunk } from "./transport.js";
import { onBeforeNavigation } from "./breadcrumbs.js";
import { storage, seededRandom } from "./utils.js";
import { onVisibilityChange, onPageHide } from "./lifecycle.js";
import { onErrorReported } from "./errors.js";

let config: ReplayConfig;
let privacyDom: ReplayPrivacyDom = {
  mask_text: [],
  block_element: [],
};
let appVersion: string | undefined;
let recorder: { stop: () => void } | null = null;
let isRecording = false;
type PauseReason = "offline" | "hidden";
const pauseReasons = new Set<PauseReason>();
let sessionRandom = 0;
let sampled = true;
let errorReplayEnabled = false;
let hadError = false;
// Holds rrweb events since the most recent FullSnapshot. Capped naturally by
// FULL_SNAPSHOT_INTERVAL_MS — on every full-snapshot boundary the buffer is
// reset (and either shipped, for sampled sessions, or dropped, for unsampled
// ones). Anything older than the last full snapshot is unrenderable on the
// server because the FullSnapshot it depended on is gone, so there's no value
// in keeping it.
let eventBuffer: unknown[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let maxRecordingTimer: ReturnType<typeof setTimeout> | null = null;
let errorReplayTimer: ReturnType<typeof setTimeout> | null = null;
let recordFn: ((opts: Record<string, unknown>) => (() => void) | undefined) | null = null;
let lifecycleUnsubscribers: (() => void)[] = [];
let listenersRegistered = false;

// Implementation details, not server-tunable. The pre-error window the
// unsampled+error_replay path captures is implicitly equal to
// FULL_SNAPSHOT_INTERVAL_MS (the buffer holds events since the latest FullSnapshot).
// POST_ERROR_TAIL_MS is how long we keep shipping after an error so the
// immediate user reaction lands in the replay too.
const FULL_SNAPSHOT_INTERVAL_MS = 60_000;
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
  replayConfig: ReplayConfig,
  version?: string,
  dom: ReplayPrivacyDom = {
    mask_text: [],
    block_element: [],
  },
): void {
  config = replayConfig;
  privacyDom = dom;
  appVersion = version;

  if (!config.enabled) return;

  // Sampling roll, narrowed by applyReplaySampling() when server config arrives.
  sessionRandom = seededRandom(getSessionId());
  sampled = sessionRandom < config.sample_rate;

  if (sampled) {
    startRecording();
  }

  // Register listeners only once — prevents accumulation on init→destroy→init cycles
  if (!listenersRegistered) {
    listenersRegistered = true;

    // Flush replay on SPA navigation so each page gets its own chunk
    onBeforeNavigation(() => {
      if (isRecording) flushChunk();
    });

    window.addEventListener("offline", pauseForOffline);
    window.addEventListener("online", resumeForOffline);

    // Pause rrweb on tab hide so background tabs don't emit incrementals
    // against a DOM the user isn't looking at — on resume rrweb naturally
    // emits a fresh FullSnapshot, which lets the server interleave chunks
    // from multiple tabs into one timeline cleanly.
    lifecycleUnsubscribers.push(
      onVisibilityChange((state) => {
        if (state === "hidden") pauseRecording("hidden");
        else if (state === "visible") resumeRecording("hidden");
      }),
    );
    lifecycleUnsubscribers.push(
      onPageHide((persisted) => {
        if (!persisted && isRecording) flushChunk(true);
      }),
    );

    // Trigger the post-error tail only for errors that actually shipped —
    // errors.ts publishes after beforeError approval, so dropped errors don't
    // open the window.
    lifecycleUnsubscribers.push(onErrorReported(() => onError()));
  }
}

/** Apply a narrowed sampling decision (kept here for the case where a
 * future version reintroduces runtime config updates for replay). */
export function applyReplaySampling(realConfig: ReplayConfig): void {
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
          // for sampled sessions we ship them now (one chunk per
          // full-snapshot interval). For unsampled sessions the previous
          // events are unrenderable without the old snapshot we're about
          // to lose, so we drop them — replay starts fresh from this
          // boundary.
          if (sampled && eventBuffer.length > 0) {
            flushChunk();
          } else {
            eventBuffer = [];
          }
        }
        eventBuffer.push(event);
      },
      // rrweb's API uses "checkout" terminology for what we call a
      // full-snapshot interval — same concept, different word.
      checkoutEveryNms: FULL_SNAPSHOT_INTERVAL_MS,
      maskAllInputs: config.mask_all_inputs,
      maskTextSelector: privacyDom.mask_text.length
        ? privacyDom.mask_text.join(", ")
        : undefined,
      blockSelector: privacyDom.block_element.length
        ? privacyDom.block_element.join(", ")
        : undefined,
      // Conventional rrweb opt-out: any element with class `rr-block` is
      // replaced with a placeholder. Lets host apps mark regions that
      // shouldn't be captured (e.g. embedded replay players, which would
      // otherwise turn into recursive nested DOM that doesn't replay
      // cleanly).
      blockClass: "rr-block",
    });

    if (stopFn) {
      recorder = { stop: stopFn as () => void };
    }
    isRecording = true;

    flushTimer = setInterval(flushChunk, FLUSH_INTERVAL_MS);

    // Clear any existing timeout from a previous start (pause→resume)
    if (maxRecordingTimer) clearTimeout(maxRecordingTimer);
    maxRecordingTimer = setTimeout(() => stopReplay(), config.max_duration_ms);
  } catch {
    // rrweb not available — skip silently
  }
}

function pauseRecording(reason: PauseReason): void {
  const wasEmpty = pauseReasons.size === 0;
  pauseReasons.add(reason);
  if (!wasEmpty || !isRecording) return;

  clearTimers();
  // Visibility-hidden may precede an OS-driven unload (mobile background),
  // so beacon the last chunk; offline can use plain fetch since the network
  // is dead either way.
  flushChunk(reason === "hidden");
  if (recorder) {
    recorder.stop();
    recorder = null;
  }
  isRecording = false;
}

function resumeRecording(reason: PauseReason): void {
  pauseReasons.delete(reason);
  if (pauseReasons.size > 0 || isRecording) return;
  if (!sampled) return;

  // rrweb takes a fresh FullSnapshot on start — that's the boundary the
  // server uses to interleave this tab's chunks with other tabs'.
  startRecording();
}

const pauseForOffline = (): void => pauseRecording("offline");
const resumeForOffline = (): void => resumeRecording("offline");

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
  pauseReasons.clear();
}

/** Flush buffered replay under the current session without stopping the recorder.
 * Pass `useBeacon=true` when a navigation is imminent (e.g. logout). */
export function flushReplay(useBeacon = false): void {
  if (isRecording) flushChunk(useBeacon);
}

export function destroyReplay(): void {
  stopReplay();
  window.removeEventListener("offline", pauseForOffline);
  window.removeEventListener("online", resumeForOffline);
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
  pauseReasons.clear();
}
