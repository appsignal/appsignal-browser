import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { initTransport, sendError, sendEvents, sendReplayChunk, destroyTransport } from "./transport.js";
import type { BrowserError, EventPayload, ReplayChunk, SessionContext } from "./types.js";

const mockSession: SessionContext = {
  session_id: "test-session",
  anonymous_id: "test-anon",
  page_url: "http://localhost/",
  referrer: "",
  user_agent: "test",
  screen_width: 1920,
  screen_height: 1080,
  viewport_width: 1200,
  viewport_height: 800,
  language: "en",
  timezone: "UTC",
};

describe("transport", () => {
  beforeEach(() => {
    initTransport("http://localhost/ingest/browser", "test-key");
    vi.restoreAllMocks();
  });

  afterEach(() => {
    // Clear retry queue and periodic drain timer to keep tests isolated.
    destroyTransport();
    vi.useRealTimers();
  });

  it("sends error payload via fetch", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());

    const payload: BrowserError = {
      type: "error",
      timestamp: Date.now(),
      message: "Test error",
      breadcrumbs: [],
      session: mockSession,
    };

    sendError(payload);

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost/ingest/browser?key=test-key",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "text/plain" },
      }),
    );
  });

  it("sends event payload via fetch", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());

    const payload: EventPayload = {
      type: "events",
      session: mockSession,
      breadcrumbs: [],
      vitals: [],
    };

    sendEvents(payload);

    expect(fetchSpy).toHaveBeenCalled();
  });

  const replayPayload = (eventsSizeBytes = 100): ReplayChunk => ({
    type: "replay",
    session_id: "sess",
    chunk_index: 0,
    events: ["x".repeat(eventsSizeBytes)],
  });

  it("sendReplayChunk without useBeacon uses plain fetch", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    const beaconSpy = vi.fn();
    (navigator as unknown as { sendBeacon: unknown }).sendBeacon = beaconSpy;

    sendReplayChunk(replayPayload());

    expect(beaconSpy).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost/ingest/browser?key=test-key",
      expect.objectContaining({ method: "POST" }),
    );
    // Plain fetch path — no keepalive
    expect(fetchSpy.mock.calls[0][1]?.keepalive).not.toBe(true);
  });

  it("sendReplayChunk with useBeacon uses sendBeacon for small payloads", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    const beaconSpy = vi.fn().mockReturnValue(true);
    (navigator as unknown as { sendBeacon: unknown }).sendBeacon = beaconSpy;

    sendReplayChunk(replayPayload(), true);

    expect(beaconSpy).toHaveBeenCalledWith(
      "http://localhost/ingest/browser?key=test-key",
      expect.any(Blob),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sendReplayChunk with useBeacon drops bodies larger than the beacon cap", () => {
    // fetch({keepalive:true}) has the same ~64 KB cap in Chromium, so there
    // is no rescue path for large bodies on unload. Callers rely on the
    // periodic flush (every 5 s for replay) having already sent recent data.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    const beaconSpy = vi.fn();
    (navigator as unknown as { sendBeacon: unknown }).sendBeacon = beaconSpy;

    sendReplayChunk(replayPayload(80 * 1024), true); // 80 KB > 64 KB cap

    expect(beaconSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("send() transmits large replay payloads up to the 10 MB limit", () => {
    // Previously capped at 512 KB; a FullSnapshot for a rich DOM routinely
    // exceeded that and was silently dropped, leaving replays without their
    // initial snapshot.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());

    sendReplayChunk(replayPayload(2 * 1024 * 1024)); // 2 MB

    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("send() still drops payloads above the 10 MB cap", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());

    sendReplayChunk(replayPayload(11 * 1024 * 1024)); // 11 MB > 10 MB cap

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("re-enqueues a chunk whose in-line retries are exhausted on 5xx", async () => {
    // Three successive 503s should exhaust MAX_RETRIES and hand the body to
    // the retry queue rather than silently dropping it. Transient server
    // outages (e.g. container restart) must not leave permanent gaps in the
    // replay chunk sequence.
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 503 }));

    sendReplayChunk(replayPayload());

    // Let the initial attempt plus all three in-line retries fire. Backoff
    // delays are 1s, 2s, 4s (plus up to 20 % jitter). 20 s is plenty.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchSpy).toHaveBeenCalledTimes(4);

    // The body is now in the retry queue. The 30 s periodic drain fires and
    // re-sends it. With the server now returning 200, no further retries.
    fetchSpy.mockResolvedValue(new Response());
    await vi.advanceTimersByTimeAsync(31_000);
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });

  it("keeps the chunk queued if the server is still 5xx when the drain fires", async () => {
    // The queue drain calls doFetch(body, 0), which starts a fresh retry
    // chain. If the server is still failing, that chain must itself
    // re-enqueue via the exhausted-retries path — otherwise a second drain
    // finds an empty queue and the chunk is silently lost.
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 503 }));

    sendReplayChunk(replayPayload());

    // First cycle: 4 attempts, then queued.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchSpy).toHaveBeenCalledTimes(4);

    // Drain fires at 30 s, server still 503. drainQueue → doFetch →
    // 4 more attempts → re-enqueue → scheduleRetryDrain for another 30 s.
    await vi.advanceTimersByTimeAsync(31_000);
    expect(fetchSpy).toHaveBeenCalledTimes(8);

    // Second drain: server finally 200. drainQueue → doFetch → success.
    fetchSpy.mockResolvedValue(new Response());
    await vi.advanceTimersByTimeAsync(61_000);
    expect(fetchSpy).toHaveBeenCalledTimes(9);
  });

  it("destroyTransport fails closed — no fetch fires after destroy", () => {
    // The endpoint/key reset and in-flight retry cancellation in
    // destroyTransport() is the fail-closed guarantee for the torn-down
    // SDK. A caller that somehow still holds a reference to sendEvents
    // (e.g. a leftover event handler) must not dispatch to the old target.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());

    sendError({
      type: "error",
      timestamp: Date.now(),
      message: "pre-destroy",
      breadcrumbs: [],
      session: mockSession,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    destroyTransport();
    fetchSpy.mockClear();

    sendError({
      type: "error",
      timestamp: Date.now(),
      message: "post-destroy",
      breadcrumbs: [],
      session: mockSession,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("re-enqueues a chunk on network error after retries exhausted", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("network"));
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });

    sendReplayChunk(replayPayload());

    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchSpy).toHaveBeenCalledTimes(4);

    // Retry queue drains after 30 s with a now-recovered server.
    fetchSpy.mockResolvedValue(new Response());
    await vi.advanceTimersByTimeAsync(31_000);
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });
});
