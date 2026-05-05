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
    rrwebEmit!({ type: 3, data: "after error" });

    vi.advanceTimersByTime(5000);
    expect(sendChunkMock).toHaveBeenCalledTimes(1);
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

  it("does not flush empty buffer", async () => {
    initReplay(defaultReplayConfig());
    await vi.advanceTimersByTimeAsync(10);

    // No events emitted
    vi.advanceTimersByTime(5000);
    expect(sendChunkMock).not.toHaveBeenCalled();
  });
});
