import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { initTransport, sendError, sendEvents, sendReplayChunk, sendVitals, destroyTransport } from "./transport.js";
import type { EventPayload, FrontendTransaction, ReplayChunk, SessionContext, VitalEntry } from "./types.js";

const mockSession: SessionContext = {
  session_id: "test-session",
  tab_id: "test-tab",
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

function errorPayload(message = "Test error"): FrontendTransaction {
  return {
    timestamp: Math.floor(Date.now() / 1000),
    namespace: "browser",
    action: "/test",
    error: { name: "Error", message, backtrace: [] },
    breadcrumbs: [],
    tags: {
      session_id: mockSession.session_id,
      tab_id: mockSession.tab_id,
      anonymous_id: mockSession.anonymous_id,
    },
    environment: { url: "http://localhost/test" },
    user_agent: "test",
  };
}

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    value: state,
    configurable: true,
  });
}

describe("transport", () => {
  beforeEach(() => {
    initTransport("http://localhost", "test-key");
    setVisibility("visible");
    vi.restoreAllMocks();
  });

  afterEach(() => {
    // Clear retry queue and periodic drain timer to keep tests isolated.
    destroyTransport();
    vi.useRealTimers();
  });

  it("POSTs errors to /collect with api_key and application/json", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());

    sendError(errorPayload());

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost/collect?api_key=test-key",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  it("sendError uses sendBeacon when document.visibilityState is hidden", () => {
    // Mid-unload the fetch can be cancelled; beacon survives. Trade-off:
    // beacon Blob type is constrained to CORS-safelisted values so JSON
    // ships as text/plain.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    const beaconSpy = vi.fn().mockReturnValue(true);
    (navigator as unknown as { sendBeacon: unknown }).sendBeacon = beaconSpy;

    setVisibility("hidden");
    sendError(errorPayload());

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(beaconSpy).toHaveBeenCalledWith(
      "http://localhost/collect?api_key=test-key",
      expect.any(Blob),
    );
  });

  it("sends event payload via fetch", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());

    const payload: EventPayload = {
      type: "events",
      session: mockSession,
      breadcrumbs: [],
    };

    sendEvents(payload);

    expect(fetchSpy).toHaveBeenCalled();
  });

  it("POSTs vitals to /metrics/webvitals as a JSON array with api_key", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());

    const vitals: VitalEntry[] = [
      { id: "v3-lcp-1", label: "browser-web-vital", name: "LCP", startTime: 1, value: 2140, page_url: "http://localhost/", rating: "good" },
      { id: "v3-cls-1", label: "browser-web-vital", name: "CLS", startTime: 2, value: 0.04, page_url: "http://localhost/", rating: "good" },
    ];

    sendVitals(vitals);

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost/metrics/webvitals?api_key=test-key",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    expect(body[0].name).toBe("LCP");
    expect(body[0].label).toBe("browser-web-vital");
    expect(body[0].id).toBe("v3-lcp-1");
  });

  it("sendVitals no-ops on an empty array", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    const beaconSpy = vi.fn().mockReturnValue(true);
    (navigator as unknown as { sendBeacon: unknown }).sendBeacon = beaconSpy;

    sendVitals([]);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(beaconSpy).not.toHaveBeenCalled();
  });

  it("sendVitals uses sendBeacon when document.visibilityState is hidden", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    const beaconSpy = vi.fn().mockReturnValue(true);
    (navigator as unknown as { sendBeacon: unknown }).sendBeacon = beaconSpy;

    setVisibility("hidden");
    sendVitals([
      { id: "v3-lcp-1", label: "browser-web-vital", name: "LCP", startTime: 1, value: 2140, page_url: "http://localhost/", rating: "good" },
    ]);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(beaconSpy).toHaveBeenCalledWith(
      "http://localhost/metrics/webvitals?api_key=test-key",
      expect.any(Blob),
    );
  });

  const replayPayload = (eventsSizeBytes = 100): ReplayChunk => ({
    type: "replay",
    session_id: "sess",
    tab_id: "tab",
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

    sendError(errorPayload("pre-destroy"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    destroyTransport();
    fetchSpy.mockClear();

    sendError(errorPayload("post-destroy"));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("evicts oldest queued payloads when total bytes exceed the cap", async () => {
    // The retry queue used to be count-bounded (100 items). Replay chunks
    // can be ~10 MB each, so an offline tab could pin ~1 GB. Switch the
    // bound to bytes — when the cap is reached, drop the oldest entries
    // until the new payload fits.
    vi.useFakeTimers();
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());

    // Each payload's serialised body is ≈9 MB; the cap is 32 MB. Queueing
    // four of them pushes the total over the cap, so the oldest gets evicted
    // and only three drain when we go back online.
    const tagged = (id: string): ReplayChunk => ({
      type: "replay",
      session_id: "s",
      tab_id: "t",
      chunk_index: 0,
      events: [id, "x".repeat(9 * 1024 * 1024)],
    });

    sendReplayChunk(tagged("#1"));
    sendReplayChunk(tagged("#2"));
    sendReplayChunk(tagged("#3"));
    sendReplayChunk(tagged("#4"));

    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const sentBodies = fetchSpy.mock.calls.map((c) => c[1]?.body as string);
    expect(sentBodies.some((b) => b.includes('"#1"'))).toBe(false);
    expect(sentBodies.some((b) => b.includes('"#2"'))).toBe(true);
    expect(sentBodies.some((b) => b.includes('"#4"'))).toBe(true);
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
