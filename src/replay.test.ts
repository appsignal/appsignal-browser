import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { initReplay, applyReplaySampling, onError, stopReplay, discardReplay } from "./replay.js";
import * as transport from "./transport.js";
import * as consent from "./consent.js";
import type { ServerConfig } from "./types.js";
import { DEFAULT_SERVER_CONFIG } from "./types.js";

// Mock transport to capture sent chunks
vi.mock("./transport.js", () => ({
  sendReplayChunk: vi.fn(),
}));

// Mock consent — start with granted
let consentState: consent.ConsentState = "granted";
const consentDeniedCallbacks: (() => void)[] = [];
const consentGrantedCallbacks: (() => void)[] = [];

vi.mock("./consent.js", () => ({
  getConsent: () => consentState,
  onConsentDenied: (cb: () => void) => consentDeniedCallbacks.push(cb),
  onConsentGranted: (cb: () => void) => consentGrantedCallbacks.push(cb),
}));

// Mock session — reads at call time so tests can change identity mid-flight
let mockSessionId = "test-session-id";
let mockTabId = "test-tab-id";

vi.mock("./session.js", () => ({
  getSessionId: () => mockSessionId,
  getTabId: () => mockTabId,
}));

// Mock breadcrumbs navigation hook
vi.mock("./breadcrumbs.js", () => ({
  onBeforeNavigation: vi.fn(),
}));

// Track rrweb record calls
let rrwebEmit: ((event: unknown, isCheckout?: boolean) => void) | null = null;
let rrwebStopFn = vi.fn();

vi.mock("@rrweb/record", () => ({
  record: (opts: Record<string, unknown>) => {
    rrwebEmit = opts.emit as typeof rrwebEmit;
    return rrwebStopFn;
  },
}));

const sendChunkMock = transport.sendReplayChunk as ReturnType<typeof vi.fn>;

function defaultReplayConfig(): ServerConfig["replay"] {
  return { ...DEFAULT_SERVER_CONFIG.replay };
}

function disabledReplayConfig(): ServerConfig["replay"] {
  return { ...DEFAULT_SERVER_CONFIG.replay, enabled: false };
}

describe("replay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sendChunkMock.mockClear();
    rrwebStopFn.mockClear();
    rrwebEmit = null;
    consentState = "granted";
    consentDeniedCallbacks.length = 0;
    consentGrantedCallbacks.length = 0;
    mockSessionId = "test-session-id";
    mockTabId = "test-tab-id";
    sessionStorage.clear();
  });

  afterEach(() => {
    discardReplay();
    vi.useRealTimers();
  });

  it("starts recording when sampled and consent granted", async () => {
    initReplay(defaultReplayConfig());
    // rrweb record is dynamically imported — resolve the promise
    await vi.advanceTimersByTimeAsync(10);
    expect(rrwebEmit).not.toBeNull();
  });

  it("does not start recording when disabled", async () => {
    initReplay(disabledReplayConfig());
    await vi.advanceTimersByTimeAsync(10);
    expect(rrwebEmit).toBeNull();
  });

  it("flushes chunks every 5 seconds", async () => {
    initReplay(defaultReplayConfig());
    await vi.advanceTimersByTimeAsync(10);

    // Emit some events
    rrwebEmit!({ type: 1, data: "snapshot" });
    rrwebEmit!({ type: 3, data: "mutation" });

    // Advance past flush interval
    vi.advanceTimersByTime(5000);

    expect(sendChunkMock).toHaveBeenCalledTimes(1);
    const chunk = sendChunkMock.mock.calls[0][0];
    expect(chunk.type).toBe("replay");
    expect(chunk.session_id).toBe("test-session-id");
    expect(chunk.tab_id).toBe("test-tab-id");
    expect(chunk.events).toHaveLength(2);
    expect(chunk.chunk_index).toBe(0);
  });

  it("does not send chunks when not sampled and no error", async () => {
    const config = defaultReplayConfig();
    config.sample_rate = 0; // Never sampled
    initReplay(config);
    await vi.advanceTimersByTimeAsync(10);

    // applyReplaySampling with error_replay enabled
    applyReplaySampling({ ...config, error_replay: true });

    // Even if events were buffered, they shouldn't be sent without an error
    vi.advanceTimersByTime(5000);
    expect(sendChunkMock).not.toHaveBeenCalled();
  });

  it("sends chunks when error_replay triggered by onError", async () => {
    const config = defaultReplayConfig();
    config.sample_rate = 0;
    // Start with default (sample_rate 1.0) so recording begins
    initReplay(defaultReplayConfig());
    await vi.advanceTimersByTimeAsync(10);

    // Apply real config that samples out but enables error replay
    applyReplaySampling({ ...config, error_replay: true });

    rrwebEmit!({ type: 3, data: "before error" });
    onError();
    // First chunk shipped immediately at the error: pre-error context.
    expect(sendChunkMock).toHaveBeenCalledTimes(1);
    expect(sendChunkMock.mock.calls[0][0].events).toContainEqual({ type: 3, data: "before error" });

    // Activity during the post-error tail keeps shipping.
    rrwebEmit!({ type: 3, data: "after error" });
    vi.advanceTimersByTime(5000);
    expect(sendChunkMock).toHaveBeenCalledTimes(2);
    expect(sendChunkMock.mock.calls[1][0].events).toContainEqual({ type: 3, data: "after error" });
  });

  it("on checkout, sampled session ships the previous buffer and starts fresh", async () => {
    // Sampled sessions ship one chunk per full-snapshot interval. When rrweb
    // emits a checkout, the previous buffer's events were anchored on the
    // *previous* FullSnapshot — they must ship before the new snapshot
    // starts a fresh chunk. Without this, the snapshot rotation would mix
    // events that depend on different anchors into one chunk.
    initReplay(defaultReplayConfig()); // sample_rate 1.0 → sampled
    await vi.advanceTimersByTimeAsync(10);

    rrwebEmit!({ type: 3, data: "before checkout" });
    // rrweb signals "fresh FullSnapshot incoming" by passing isCheckout=true
    // on the next emit.
    rrwebEmit!({ type: 2, data: "checkout snapshot" }, true);

    // The pre-checkout buffer is shipped synchronously inside the emit
    // handler; the new snapshot starts a fresh buffer.
    expect(sendChunkMock).toHaveBeenCalledTimes(1);
    expect(sendChunkMock.mock.calls[0][0].events).toEqual([
      { type: 3, data: "before checkout" },
    ]);
  });

  it("on checkout, unsampled error_replay session drops the previous buffer", async () => {
    // The old FullSnapshot is about to be replaced. Mutations buffered
    // against it become unrenderable as soon as the new snapshot lands —
    // shipping them on a future error would just produce broken replay.
    // Drop them and let the new snapshot anchor a fresh window.
    initReplay(defaultReplayConfig());
    await vi.advanceTimersByTimeAsync(10);
    applyReplaySampling({ ...defaultReplayConfig(), sample_rate: 0, error_replay: true });

    rrwebEmit!({ type: 3, data: "old mutation" }); // anchored on the old snapshot
    rrwebEmit!({ type: 2, data: "new snapshot" }, true);
    rrwebEmit!({ type: 3, data: "new mutation" });

    onError();

    expect(sendChunkMock).toHaveBeenCalledTimes(1);
    const shipped = sendChunkMock.mock.calls[0][0].events as Array<Record<string, unknown>>;
    expect(shipped).toContainEqual({ type: 2, data: "new snapshot" });
    expect(shipped).toContainEqual({ type: 3, data: "new mutation" });
    expect(shipped).not.toContainEqual({ type: 3, data: "old mutation" });
  });

  it("discards buffer without flushing", async () => {
    initReplay(defaultReplayConfig());
    await vi.advanceTimersByTimeAsync(10);

    rrwebEmit!({ type: 1, data: "snapshot" });
    discardReplay();

    vi.advanceTimersByTime(5000);
    expect(sendChunkMock).not.toHaveBeenCalled();
  });

  it("stopReplay stops rrweb recorder", async () => {
    initReplay(defaultReplayConfig());
    await vi.advanceTimersByTimeAsync(10);

    rrwebEmit!({ type: 1, data: "snapshot" });
    stopReplay();

    expect(rrwebStopFn).toHaveBeenCalled();
  });

  it("stopReplay flushes remaining events", async () => {
    initReplay(defaultReplayConfig());
    await vi.advanceTimersByTimeAsync(10);

    rrwebEmit!({ type: 1, data: "snapshot" });
    stopReplay();

    expect(sendChunkMock).toHaveBeenCalledTimes(1);
  });

  it("increments chunk_index across flushes", async () => {
    initReplay(defaultReplayConfig());
    await vi.advanceTimersByTimeAsync(10);

    rrwebEmit!({ type: 1, data: "a" });
    vi.advanceTimersByTime(5000);

    rrwebEmit!({ type: 1, data: "b" });
    vi.advanceTimersByTime(5000);

    expect(sendChunkMock).toHaveBeenCalledTimes(2);
    const idx0 = sendChunkMock.mock.calls[0][0].chunk_index;
    const idx1 = sendChunkMock.mock.calls[1][0].chunk_index;
    expect(idx1).toBe(idx0 + 1);
  });

  it("keeps chunk_index per tab — switching tabs starts a fresh counter", async () => {
    // Headline contract of (session_id, tab_id, chunk_index): two tabs of one
    // session must not collide. Each tab's counter is independent and starts
    // at 0; the server disambiguates by the full triple.
    initReplay(defaultReplayConfig());
    await vi.advanceTimersByTimeAsync(10);

    rrwebEmit!({ type: 1, data: "a" });
    vi.advanceTimersByTime(5000);
    rrwebEmit!({ type: 1, data: "b" });
    vi.advanceTimersByTime(5000);

    // Switch to a sibling tab in the same session.
    mockTabId = "other-tab-id";
    rrwebEmit!({ type: 1, data: "c" });
    vi.advanceTimersByTime(5000);

    expect(sendChunkMock).toHaveBeenCalledTimes(3);
    expect(sendChunkMock.mock.calls[0][0].tab_id).toBe("test-tab-id");
    expect(sendChunkMock.mock.calls[0][0].chunk_index).toBe(0);
    expect(sendChunkMock.mock.calls[1][0].tab_id).toBe("test-tab-id");
    expect(sendChunkMock.mock.calls[1][0].chunk_index).toBe(1);
    expect(sendChunkMock.mock.calls[2][0].tab_id).toBe("other-tab-id");
    expect(sendChunkMock.mock.calls[2][0].chunk_index).toBe(0);
  });

  it("post-error tail expires so a single early error doesn't ship the whole session", async () => {
    // Without bounding, one onError() flips hadError true forever — every
    // subsequent flush ships, so a single error 30 s into a 4-hour session
    // uploads all 4 hours of replay. The post-error tail must re-close
    // after a bounded window with no new errors.
    initReplay(defaultReplayConfig());
    await vi.advanceTimersByTimeAsync(10);

    applyReplaySampling({ ...defaultReplayConfig(), sample_rate: 0, error_replay: true });

    rrwebEmit!({ type: 3, data: "before error" });
    onError();

    // Immediate flush of pre-error context.
    expect(sendChunkMock).toHaveBeenCalledTimes(1);
    sendChunkMock.mockClear();

    // Drift well past the post-error window with no new errors.
    vi.advanceTimersByTime(60_000);

    // New activity, no new error → must not ship.
    rrwebEmit!({ type: 3, data: "long after window" });
    vi.advanceTimersByTime(5000);

    expect(sendChunkMock).not.toHaveBeenCalled();
  });

  it("absorbs additional errors that fire during the active post-error tail", async () => {
    // Each error opens a single fixed window. Errors that land while the
    // tail is still active are absorbed — they don't trigger a fresh flush
    // or extend the window. This bounds per-session upload for cascading
    // errors. The first error's tail keeps shipping subsequent activity
    // anyway, so the second error's context is already captured.
    initReplay(defaultReplayConfig());
    await vi.advanceTimersByTimeAsync(10);

    applyReplaySampling({ ...defaultReplayConfig(), sample_rate: 0, error_replay: true });

    rrwebEmit!({ type: 3, data: "first" });
    onError();
    expect(sendChunkMock).toHaveBeenCalledTimes(1);

    // Second error 2 s into the 5 s tail. Should NOT trigger another
    // immediate flush — buffer is empty anyway, but the absorb policy
    // means even if there were buffered events, no fresh flush fires.
    vi.advanceTimersByTime(2000);
    rrwebEmit!({ type: 3, data: "second" });
    onError();
    expect(sendChunkMock).toHaveBeenCalledTimes(1);

    // The original tail still ships subsequent activity via flushTimer.
    vi.advanceTimersByTime(3000); // total 5 s after first error → tail closes
    expect(sendChunkMock).toHaveBeenCalledTimes(2);
    expect(sendChunkMock.mock.calls[1][0].events).toContainEqual({ type: 3, data: "second" });

    // After tail closes, a fresh error opens a new window.
    sendChunkMock.mockClear();
    vi.advanceTimersByTime(10_000);
    rrwebEmit!({ type: 3, data: "third" });
    onError();
    expect(sendChunkMock).toHaveBeenCalledTimes(1);
  });

  it("sampling decision is stable across reinit within the same session", async () => {
    // sessionRandom must be derived from session_id, not Math.random — otherwise
    // a multi-page app re-rolls on every page load and "% of sessions" becomes
    // "% of page loads". With Math.random returning 0.1 then 0.9 against a
    // sample_rate of 0.5, the bug gives sampled=true then sampled=false on the
    // two inits; the fix gives the same decision both times.
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0.1)
      .mockReturnValueOnce(0.9);

    const config = { ...defaultReplayConfig(), sample_rate: 0.5 };

    initReplay(config);
    await vi.advanceTimersByTimeAsync(10);
    const firstActive = rrwebEmit !== null;
    rrwebEmit = null;
    discardReplay();

    initReplay(config);
    await vi.advanceTimersByTimeAsync(10);
    const secondActive = rrwebEmit !== null;

    expect(secondActive).toBe(firstActive);
  });

  it("does not flush empty buffer", async () => {
    initReplay(defaultReplayConfig());
    await vi.advanceTimersByTimeAsync(10);

    // No events emitted
    vi.advanceTimersByTime(5000);
    expect(sendChunkMock).not.toHaveBeenCalled();
  });
});
