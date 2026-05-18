import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { init, destroy, endSession, setUser, clearUser, addBreadcrumb, captureError, flush } from "./index.js";
import type { ServerConfig } from "./types.js";
import { DEFAULT_SERVER_CONFIG } from "./types.js";
import { RingBuffer } from "./ring-buffer.js";

// jsdom's Blob may lack .text(); polyfill via FileReader so the sendBeacon
// mock below can read body strings out of beacon calls.
if (typeof Blob.prototype.text !== "function") {
  Blob.prototype.text = function () {
    return new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsText(this as unknown as Blob);
    });
  };
}

// Mock rrweb — replay tries to dynamically import it. Capture the emit
// hook so tests can simulate rrweb pushing events through replay's pipeline.
let rrwebEmit: ((event: unknown, isCheckout?: boolean) => void) | null = null;
vi.mock("@rrweb/record", () => ({
  record: (opts: Record<string, unknown>) => {
    rrwebEmit = opts.emit as typeof rrwebEmit;
    return () => {};
  },
}));

// Track what the SDK sends
let sentPayloads: { url: string; body: string }[] = [];
let serverConfigResponse: ServerConfig = DEFAULT_SERVER_CONFIG;

function mockFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;

  // Server config endpoint
  if (urlStr.includes("/ingest/browser/config")) {
    return Promise.resolve(new Response(JSON.stringify(serverConfigResponse), { status: 200 }));
  }

  // Ingestion endpoint — record the payload
  sentPayloads.push({ url: urlStr, body: (init?.body as string) || "" });
  return Promise.resolve(new Response(null, { status: 200 }));
}

describe("SDK integration", () => {
  beforeEach(() => {
    sentPayloads = [];
    serverConfigResponse = { ...DEFAULT_SERVER_CONFIG };
    rrwebEmit = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(mockFetch);
    // jsdom's sendBeacon doesn't route through our fetch mock; record the
    // body into sentPayloads ourselves so beacon flushes (page hide,
    // endSession) are visible to assertions.
    (navigator as unknown as { sendBeacon: (url: string, blob: Blob) => boolean }).sendBeacon =
      (url, blob) => {
        blob.text().then(body => sentPayloads.push({ url, body }));
        return true;
      };
    // Reset per-tab replay counters (sessionStorage) and session identity
    // (localStorage) so each test starts with no SDK state.
    sessionStorage.clear();
    localStorage.clear();
  });

  afterEach(() => {
    destroy();
    vi.restoreAllMocks();
  });

  it("initializes, collects breadcrumbs, and flushes them", () => {
    init({ key: "test-key" });

    addBreadcrumb({ category: "test", message: "hello" });
    flush();

    const eventPayloads = sentPayloads.filter(p => {
      try { return JSON.parse(p.body).type === "events"; } catch { return false; }
    });
    expect(eventPayloads.length).toBeGreaterThan(0);

    const body = JSON.parse(eventPayloads[0].body);
    expect(body.type).toBe("events");
    expect(body.session.session_id).toBeTruthy();
    // Should contain our manual breadcrumb plus any auto-collected ones
    const testCrumb = body.breadcrumbs.find((b: { category: string }) => b.category === "test");
    expect(testCrumb).toBeDefined();
    expect(testCrumb.message).toBe("hello");
  });

  it("does not send before init", () => {
    // These should all be no-ops before init
    addBreadcrumb({ category: "test", message: "should be ignored" });
    setUser({ email: "test@test.com" });
    clearUser();
    flush();

    expect(sentPayloads).toHaveLength(0);
  });

  it("sends events to the correct endpoint with ingestion key", () => {
    init({ key: "my-key", endpoint: "https://example.com" });

    addBreadcrumb({ category: "test", message: "check url" });
    flush();

    const eventPayloads = sentPayloads.filter(p => p.url.includes("ingest/browser"));
    expect(eventPayloads.length).toBeGreaterThan(0);
    expect(eventPayloads[0].url).toContain("key=my-key");
    expect(eventPayloads[0].url).toMatch(/^https:\/\/example\.com\/ingest\/browser/);
  });

  it("tolerates a server config that omits the privacy block", async () => {
    // Reproduces the collector's actual shape: privacy is server-only
    // (#[serde(skip_serializing)]), so the SDK has to backfill it with
    // defaults rather than crash in applyServerConfig.
    serverConfigResponse = {
      enabled: true,
      errors: { enabled: true, sample_rate: 1.0 },
      breadcrumbs: DEFAULT_SERVER_CONFIG.breadcrumbs,
      web_vitals: { enabled: true },
      replay: DEFAULT_SERVER_CONFIG.replay,
      session: { inactivity_timeout_ms: 1_800_000 },
    } as unknown as ServerConfig;

    init({ key: "test-key" });
    await new Promise(r => setTimeout(r, 50));

    // No throw on init = success path covered. Sanity-check that the rest
    // of the pipeline still ships events after the defensive merge runs.
    sentPayloads = [];
    addBreadcrumb({ category: "test", message: "post-merge" });
    flush();

    const eventPayloads = sentPayloads.filter(p => {
      try { return JSON.parse(p.body).type === "events"; } catch { return false; }
    });
    expect(eventPayloads.length).toBeGreaterThan(0);
  });

  it("applies server config that disables collection", async () => {
    serverConfigResponse = { ...DEFAULT_SERVER_CONFIG, enabled: false };

    init({ key: "test-key" });

    // Wait for server config fetch + apply to complete
    await new Promise(r => setTimeout(r, 50));

    // Clear any payloads sent during init (before config arrived)
    sentPayloads = [];

    addBreadcrumb({ category: "test", message: "after disable" });
    flush();

    const eventPayloads = sentPayloads.filter(p => {
      try { return JSON.parse(p.body).type === "events"; } catch { return false; }
    });
    expect(eventPayloads).toHaveLength(0);
  });

  it("applies server config that changes error sampling", async () => {
    serverConfigResponse = {
      ...DEFAULT_SERVER_CONFIG,
      errors: { enabled: true, sample_rate: 0 }, // Sample nothing
    };

    init({ key: "test-key" });

    // Wait for config application
    await new Promise(r => setTimeout(r, 50));

    sentPayloads = [];

    // Trigger an error — should be dropped by 0% sample rate
    const error = new ErrorEvent("error", {
      message: "sampled out",
      filename: "test.js",
      lineno: 1,
    });
    window.dispatchEvent(error);

    // Give time for any async sends
    await new Promise(r => setTimeout(r, 50));

    const errorPayloads = sentPayloads.filter(p => {
      try { return JSON.parse(p.body).type === "error"; } catch { return false; }
    });
    expect(errorPayloads).toHaveLength(0);
  });

  it("second init call is ignored", () => {
    init({ key: "key-1" });
    init({ key: "key-2" });

    addBreadcrumb({ category: "test", message: "only one init" });
    flush();

    // All sends should use key-1, not key-2
    const eventPayloads = sentPayloads.filter(p => p.url.includes("ingest/browser?key="));
    for (const p of eventPayloads) {
      expect(p.url).toContain("key=key-1");
    }
  });

  it("destroy stops collection and cleans up", () => {
    init({ key: "test-key" });

    addBreadcrumb({ category: "before", message: "before destroy" });
    flush();

    const beforeCount = sentPayloads.length;

    destroy();

    // After destroy, nothing should be sent
    sentPayloads = [];
    addBreadcrumb({ category: "after", message: "after destroy" });
    flush();

    const afterPayloads = sentPayloads.filter(p => {
      try { return JSON.parse(p.body).type === "events"; } catch { return false; }
    });
    expect(afterPayloads).toHaveLength(0);
  });

  it("captureError sends error payload", () => {
    init({ key: "test-key" });

    captureError(new Error("manual error"));

    const errorPayloads = sentPayloads.filter(p => {
      try { return JSON.parse(p.body).type === "error"; } catch { return false; }
    });
    expect(errorPayloads.length).toBeGreaterThan(0);

    const body = JSON.parse(errorPayloads[0].body);
    expect(body.message).toBe("manual error");
    expect(body.session.session_id).toBeTruthy();
  });

  it("endSession rotates session_id and clears user between flushes", () => {
    // Public contract: events captured before endSession() carry session A,
    // events captured after carry a fresh session B, and user identity is
    // cleared in the process.
    init({ key: "test-key" });
    setUser({ id: "u1", email: "one@test.com" });

    addBreadcrumb({ category: "before", message: "before logout" });
    flush();

    const beforePayloads = sentPayloads
      .map(p => { try { return JSON.parse(p.body) } catch { return null } })
      .filter(b => b?.type === "events");
    expect(beforePayloads.length).toBeGreaterThan(0);
    const sessionBefore = beforePayloads[0].session.session_id;
    expect(beforePayloads[0].session.user_id).toBe("u1");

    // Rotate
    sentPayloads = [];
    endSession();

    addBreadcrumb({ category: "after", message: "after logout" });
    flush();

    const afterPayloads = sentPayloads
      .map(p => { try { return JSON.parse(p.body) } catch { return null } })
      .filter(b => b?.type === "events");
    expect(afterPayloads.length).toBeGreaterThan(0);
    expect(afterPayloads[0].session.session_id).not.toBe(sessionBefore);
    expect(afterPayloads[0].session.user_id).toBeUndefined();
  });

  it("breadcrumbs and errors collected before server config arrives are still sent after", async () => {
    // Collect-before-config contract from the README: data captured during
    // the fallback-config window must survive the real config arriving.
    // Breadcrumbs are buffered until flush; errors are sent immediately.
    init({ key: "test-key" });
    addBreadcrumb({ category: "early", message: "before config" });
    captureError(new Error("pre-config error"));

    // Let the config-fetch promise resolve and applyServerConfig run.
    await new Promise(r => setTimeout(r, 50));

    flush();

    const parsed = sentPayloads.map(p => {
      try { return JSON.parse(p.body); } catch { return null; }
    });

    // The error was sent immediately, before the config arrived.
    const errorPayload = parsed.find(b => b?.type === "error" && b?.message === "pre-config error");
    expect(errorPayload).toBeDefined();

    // The breadcrumb sat in the buffer through applyServerConfig and only
    // shipped on the post-config flush — proves updateBreadcrumbConfig does
    // not drop the buffer on a normal (enabled) config arrival.
    const eventPayloads = parsed.filter(b => b?.type === "events");
    const early = eventPayloads
      .flatMap(p => p.breadcrumbs)
      .find((b: { category: string }) => b.category === "early");
    expect(early).toBeDefined();
  });

  it("replay buffer is discarded when server config narrows sample_rate to exclude this session", async () => {
    // Fallback config has sample_rate 1.0 so recording starts immediately.
    // When the real config narrows to 0.5, the session-derived sampling roll
    // is re-evaluated against the new threshold; if the session is no longer
    // sampled (and error_replay is off), the buffered events are discarded.
    // session_id "sample-low" hashes to ≈0.7497, which sits above 0.5.
    localStorage.setItem("appsignal_session_id", "sample-low");
    localStorage.setItem("appsignal_last_activity", String(Date.now()));
    serverConfigResponse = {
      ...DEFAULT_SERVER_CONFIG,
      replay: { ...DEFAULT_SERVER_CONFIG.replay, sample_rate: 0.5, error_replay: false },
    };

    init({ key: "test-key" });

    // Let the rrweb dynamic import resolve so emit is captured, then push
    // some events through the fallback-window pipeline.
    await new Promise(r => setTimeout(r, 20));
    rrwebEmit?.({ type: 1, data: "fallback snapshot" });
    rrwebEmit?.({ type: 3, data: "fallback mutation" });

    // Wait for the config to arrive and applyServerConfig → applyReplaySampling
    // to discard the buffer.
    await new Promise(r => setTimeout(r, 50));

    // Anything pushed after the discard would also be ignored.
    rrwebEmit?.({ type: 3, data: "post-config" });
    flush();

    const replayPayloads = sentPayloads
      .map(p => { try { return JSON.parse(p.body); } catch { return null; } })
      .filter(b => b?.type === "replay");
    expect(replayPayloads).toHaveLength(0);
  });

  it("replay buffer is flushed when server config keeps the session sampled", async () => {
    // session_id "s2" hashes to ≈0.0208, well below sample_rate 0.1.
    localStorage.setItem("appsignal_session_id", "s2");
    localStorage.setItem("appsignal_last_activity", String(Date.now()));
    serverConfigResponse = {
      ...DEFAULT_SERVER_CONFIG,
      replay: { ...DEFAULT_SERVER_CONFIG.replay, sample_rate: 0.1 },
    };

    init({ key: "test-key" });

    await new Promise(r => setTimeout(r, 20));
    rrwebEmit?.({ type: 1, data: "snapshot" });
    rrwebEmit?.({ type: 3, data: "mutation" });

    await new Promise(r => setTimeout(r, 50));

    endSession();
    // Beacon sends record into sentPayloads asynchronously (Blob.text()).
    await new Promise(r => setTimeout(r, 10));

    const replayPayloads = sentPayloads
      .map(p => { try { return JSON.parse(p.body); } catch { return null; } })
      .filter(b => b?.type === "replay");
    expect(replayPayloads.length).toBeGreaterThan(0);
    expect(replayPayloads[0].events.length).toBeGreaterThan(0);
  });

  it("attaches tab_id to event and error payloads", () => {
    init({ key: "test-key" });

    addBreadcrumb({ category: "test", message: "tab id check" });
    captureError(new Error("tab id error"));
    flush();

    const eventPayloads = sentPayloads
      .map(p => { try { return JSON.parse(p.body) } catch { return null } })
      .filter(b => b?.type === "events");
    const errorPayloads = sentPayloads
      .map(p => { try { return JSON.parse(p.body) } catch { return null } })
      .filter(b => b?.type === "error");

    expect(eventPayloads.length).toBeGreaterThan(0);
    expect(errorPayloads.length).toBeGreaterThan(0);

    // Both kinds of payload carry tab_id, and within one tab they share it.
    const eventTab = eventPayloads[0].session.tab_id;
    const errorTab = errorPayloads[0].session.tab_id;
    expect(eventTab).toBeTruthy();
    expect(eventTab).toBe(errorTab);
    // tab_id is distinct from session_id.
    expect(eventTab).not.toBe(eventPayloads[0].session.session_id);
  });

  it("beforeError dropping the error also suppresses the error_replay tail", async () => {
    // The error_replay window should fire only for errors that actually
    // shipped. If beforeError returns null, the error never reached the
    // server — so the replay tail it would have triggered should also be
    // suppressed. session_id "sample-low" hashes ≈0.7497, well above the
    // sample_rate of 0; the only path to a replay flush is via hadError,
    // which beforeError's null return must prevent.
    localStorage.setItem("appsignal_session_id", "sample-low");
    localStorage.setItem("appsignal_last_activity", String(Date.now()));
    serverConfigResponse = {
      ...DEFAULT_SERVER_CONFIG,
      replay: { ...DEFAULT_SERVER_CONFIG.replay, sample_rate: 0, error_replay: true },
    };

    init({
      key: "test-key",
      beforeError: () => null,
    });

    // Wait for server config to apply (sampled=false, errorReplay=true).
    await new Promise((r) => setTimeout(r, 50));

    // rrweb dynamic-import resolves; emit some events so the buffer isn't empty.
    rrwebEmit?.({ type: 1, data: "snapshot" });
    rrwebEmit?.({ type: 3, data: "mutation" });

    // Error fires; beforeError drops it.
    captureError(new Error("dropped by beforeError"));

    // endSession force-flushes the replay buffer via beacon.
    endSession();
    await new Promise((r) => setTimeout(r, 10));

    const replayPayloads = sentPayloads
      .map((p) => { try { return JSON.parse(p.body); } catch { return null; } })
      .filter((b) => b?.type === "replay");
    expect(replayPayloads).toHaveLength(0);

    // Sanity check: the error itself didn't ship either.
    const errorPayloads = sentPayloads
      .map((p) => { try { return JSON.parse(p.body); } catch { return null; } })
      .filter((b) => b?.type === "error");
    expect(errorPayloads).toHaveLength(0);
  });

  it("dropped noise errors leave a later real error's breadcrumb trail clean", () => {
    // The user-visible payoff of early-pipeline filtering. Fire 8 noisy
    // ResizeObserver errors (beforeError drops them) then a real one. The
    // real error's payload.breadcrumbs[] must carry zero ResizeObserver
    // error breadcrumbs — the early-pipeline drop has to skip the
    // breadcrumb add, not just the send. If beforeError ran late (like the
    // old beforeSend), the ring buffer would be flooded with error
    // breadcrumbs before the dropped error's payload was rejected.
    init({
      key: "test-key",
      beforeError: (e) => /ResizeObserver/.test(e.message) ? null : e,
    });

    for (let i = 0; i < 8; i++) {
      captureError(new Error(`ResizeObserver loop limit exceeded #${i}`));
    }
    captureError(new Error("real diagnostic error after noise"));

    const errorPayloads = sentPayloads
      .map((p) => { try { return JSON.parse(p.body); } catch { return null; } })
      .filter((b) => b?.type === "error");

    expect(errorPayloads).toHaveLength(1);
    expect(errorPayloads[0].message).toBe("real diagnostic error after noise");

    const noisyErrorCrumbs = (
      errorPayloads[0].breadcrumbs as Array<{ category: string; message: string }>
    ).filter((b) => b.category === "error" && b.message.includes("ResizeObserver"));
    expect(noisyErrorCrumbs).toHaveLength(0);
  });

  it("destroy fully unwinds the fetch patch chain when tracing is enabled", async () => {
    // Both breadcrumbs and tracing patch window.fetch. Tracing patches *after*
    // breadcrumbs, so it is the outer wrapper. If destroy unwinds in the wrong
    // order, window.fetch is left pointing at the orphaned breadcrumbs wrapper
    // — fetches still work, but every fetch silently pushes a "network"
    // breadcrumb into a buffer nobody drains.
    const pushSpy = vi.spyOn(RingBuffer.prototype, "push");

    init({ key: "test-key", tracePropagationTargets: ["**/*"] });

    destroy();
    const baseline = pushSpy.mock.calls.length;

    await fetch("http://random.example.com/api");

    expect(pushSpy.mock.calls.length).toBe(baseline);
  });

  it("setUser attaches user context to payloads", () => {
    init({ key: "test-key" });

    setUser({ id: "u1", email: "test@test.com", name: "Test User" });

    addBreadcrumb({ category: "test", message: "with user" });
    flush();

    const eventPayloads = sentPayloads.filter(p => {
      try { return JSON.parse(p.body).type === "events"; } catch { return false; }
    });
    expect(eventPayloads.length).toBeGreaterThan(0);

    const body = JSON.parse(eventPayloads[0].body);
    expect(body.session.user_id).toBe("u1");
    expect(body.session.user_email).toBe("test@test.com");
  });
});
