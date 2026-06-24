import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { init, destroy, endSession, setUser, clearUser, addBreadcrumb, captureError, flush } from "./index.js";
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

// Track what the SDK sends
let sentPayloads: { url: string; body: string }[] = [];

function mockFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
  sentPayloads.push({ url: urlStr, body: (init?.body as string) || "" });
  return Promise.resolve(new Response(null, { status: 200 }));
}

describe("SDK integration", () => {
  beforeEach(() => {
    sentPayloads = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(mockFetch);
    // jsdom's sendBeacon doesn't route through our fetch mock; record the
    // body into sentPayloads ourselves so beacon flushes (page hide,
    // endSession) are visible to assertions.
    (navigator as unknown as { sendBeacon: (url: string, blob: Blob) => boolean }).sendBeacon =
      (url, blob) => {
        blob.text().then(body => sentPayloads.push({ url, body }));
        return true;
      };
    // Reset session identity so each test starts fresh.
    sessionStorage.clear();
    localStorage.clear();
  });

  afterEach(() => {
    destroy();
    vi.restoreAllMocks();
  });

  it("initializes, collects breadcrumbs, and flushes them", () => {
    init({ key: "test-key", session: { enabled: true } });

    addBreadcrumb({ category: "test", message: "hello" });
    flush();

    const eventPayloads = sentPayloads.filter(p => {
      try { return JSON.parse(p.body).type === "events"; } catch { return false; }
    });
    expect(eventPayloads.length).toBeGreaterThan(0);

    const body = JSON.parse(eventPayloads[0].body);
    expect(body.type).toBe("events");
    expect(body.session.session_id).toBeTruthy();
    const testCrumb = body.breadcrumbs.find((b: { category: string }) => b.category === "test");
    expect(testCrumb).toBeDefined();
    expect(testCrumb.message).toBe("hello");
    // Web vitals ride inside the events payload (empty here — none collected).
    expect(body.vitals).toEqual([]);
  });

  it("does not send before init", () => {
    addBreadcrumb({ category: "test", message: "should be ignored" });
    setUser({ email: "test@test.com" });
    clearUser();
    flush();

    expect(sentPayloads).toHaveLength(0);
  });

  it("sends events to the correct endpoint with ingestion key", () => {
    init({ key: "my-key", endpoint: "https://example.com", session: { enabled: true } });

    addBreadcrumb({ category: "test", message: "check url" });
    flush();

    const eventPayloads = sentPayloads.filter(p => p.url.includes("ingest/browser"));
    expect(eventPayloads.length).toBeGreaterThan(0);
    expect(eventPayloads[0].url).toContain("key=my-key");
    expect(eventPayloads[0].url).toMatch(/^https:\/\/example\.com\/ingest\/browser/);
  });

  it("applies errors.sampleRate=0 from init to drop every error", () => {
    init({ key: "test-key", errors: { sampleRate: 0 } });

    const error = new ErrorEvent("error", {
      message: "sampled out",
      filename: "test.js",
      lineno: 1,
    });
    window.dispatchEvent(error);

    const errorPayloads = sentPayloads.filter(p => p.url.includes("/ingest/browser/errors"));
    expect(errorPayloads).toHaveLength(0);
  });

  it("second init call is ignored", () => {
    init({ key: "key-1", session: { enabled: true } });
    init({ key: "key-2" });

    addBreadcrumb({ category: "test", message: "only one init" });
    flush();

    const eventPayloads = sentPayloads.filter(p => p.url.includes("/ingest/browser"));
    expect(eventPayloads.length).toBeGreaterThan(0);
    for (const p of eventPayloads) {
      expect(p.url).toContain("api_key=key-1");
    }
  });

  it("destroy stops collection and cleans up", () => {
    init({ key: "test-key", session: { enabled: true } });

    addBreadcrumb({ category: "before", message: "before destroy" });
    flush();

    destroy();

    sentPayloads = [];
    addBreadcrumb({ category: "after", message: "after destroy" });
    flush();

    const afterPayloads = sentPayloads.filter(p => {
      try { return JSON.parse(p.body).type === "events"; } catch { return false; }
    });
    expect(afterPayloads).toHaveLength(0);
  });

  it("captureError sends error payload", () => {
    init({ key: "test-key", session: { enabled: true } });

    captureError(new Error("manual error"));

    // Errors POST to /ingest/browser/errors as FrontendTransaction; events
    // POST to /ingest/browser. Distinguish by URL path.
    const errorPayloads = sentPayloads.filter(p => p.url.includes("/ingest/browser/errors"));
    expect(errorPayloads.length).toBeGreaterThan(0);

    const body = JSON.parse(errorPayloads[0].body);
    expect(body.error.message).toBe("manual error");
  });

  it("endSession rotates session_id and clears user between flushes", () => {
    // Public contract: events captured before endSession() carry session A,
    // events captured after carry a fresh session B, and user identity is
    // cleared in the process.
    init({ key: "test-key", session: { enabled: true } });
    setUser({ id: "u1", email: "one@test.com" });

    addBreadcrumb({ category: "before", message: "before logout" });
    flush();

    const beforePayloads = sentPayloads
      .map(p => { try { return JSON.parse(p.body) } catch { return null } })
      .filter(b => b?.type === "events");
    expect(beforePayloads.length).toBeGreaterThan(0);
    const sessionBefore = beforePayloads[0].session.session_id;
    expect(beforePayloads[0].session.user_id).toBe("u1");

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

  it("attaches tab_id to event payloads, distinct from session_id", () => {
    init({ key: "test-key", session: { enabled: true } });

    addBreadcrumb({ category: "test", message: "tab id check" });
    flush();

    const eventPayloads = sentPayloads
      .filter(p => p.url.includes("/ingest/browser") && !p.url.includes("/errors"))
      .map(p => { try { return JSON.parse(p.body) } catch { return null } })
      .filter(b => b?.type === "events");
    expect(eventPayloads.length).toBeGreaterThan(0);

    const session = eventPayloads[0].session;
    expect(session.tab_id).toBeTruthy();
    expect(session.tab_id).not.toBe(session.session_id);
  });

  it("dropped noise errors leave a later real error's breadcrumb trail clean", () => {
    // The user-visible payoff of early-pipeline filtering. Errors no longer
    // bundle breadcrumbs themselves (FrontendTransaction is minimal); the
    // breadcrumb trail flows separately via the events stream. The drop has
    // to skip the breadcrumb add, not just the send — otherwise the next
    // events flush carries ResizeObserver noise.
    init({
      key: "test-key",
      beforeError: (e) => /ResizeObserver/.test(e.message) ? null : e,
      session: { enabled: true },
    });

    for (let i = 0; i < 8; i++) {
      captureError(new Error(`ResizeObserver loop limit exceeded #${i}`));
    }
    captureError(new Error("real diagnostic error after noise"));
    flush();

    const errorPayloads = sentPayloads
      .filter((p) => p.url.includes("/ingest/browser/errors"))
      .map((p) => { try { return JSON.parse(p.body); } catch { return null; } })
      .filter((b) => !!b);

    expect(errorPayloads).toHaveLength(1);
    expect(errorPayloads[0].error.message).toBe("real diagnostic error after noise");

    const eventBodies = sentPayloads
      .filter((p) => p.url.includes("/ingest/browser") && !p.url.includes("/errors"))
      .map((p) => { try { return JSON.parse(p.body); } catch { return null; } })
      .filter((b) => b?.type === "events");
    const noisyErrorCrumbs = eventBodies
      .flatMap((b) => (b.breadcrumbs ?? []) as Array<{ category: string; message: string }>)
      .filter((b) => b.category === "error" && b.message.includes("ResizeObserver"));
    expect(noisyErrorCrumbs).toHaveLength(0);
  });

  it("session.enabled=false (default) ships only errors, no journey events", () => {
    // With the session/journey stream disabled (the default), breadcrumb
    // activity alone must not produce an events payload — only errors leave
    // the browser (web vitals would still ride an events payload, but none are
    // emitted in jsdom).
    init({ key: "test-key", session: { enabled: false } });

    addBreadcrumb({ category: "test", message: "should not ship" });
    captureError(new Error("real error"));
    flush();

    const eventPayloads = sentPayloads
      .filter((p) => p.url.includes("/ingest/browser") && !p.url.includes("/errors"))
      .map((p) => { try { return JSON.parse(p.body); } catch { return null; } })
      .filter((b) => b?.type === "events");
    const errorPayloads = sentPayloads
      .filter((p) => p.url.includes("/ingest/browser/errors"))
      .map((p) => { try { return JSON.parse(p.body); } catch { return null; } })
      .filter((b) => !!b);

    expect(eventPayloads).toHaveLength(0);
    expect(errorPayloads.length).toBeGreaterThan(0);
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
    init({ key: "test-key", session: { enabled: true } });

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

  it("error tags are exactly the setUser attributes, passed through verbatim", () => {
    init({ key: "test-key" });
    setUser({ id: "u1", email: "test@test.com", plan: "pro" });

    captureError(new Error("tagged"));

    const errorPayloads = sentPayloads
      .filter((p) => p.url.includes("/ingest/browser/errors"))
      .map((p) => { try { return JSON.parse(p.body); } catch { return null; } })
      .filter((b) => !!b);
    expect(errorPayloads.length).toBeGreaterThan(0);

    // Exact match: every key the host set is present, and nothing else is
    // (no SDK-injected identity).
    expect(errorPayloads[0].tags).toEqual({ id: "u1", email: "test@test.com", plan: "pro" });
  });
});
