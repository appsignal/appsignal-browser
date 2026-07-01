import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { init, destroy, endSession, setUser, clearUser, setTags, clearTags, addBreadcrumb, captureError, flush } from "./index.js";
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

  it("active:false makes init a complete no-op — nothing patched, nothing sent", () => {
    init({ key: "test-key", endpoint: "https://example.com", session: { enabled: true }, active: false });

    // Every collection path: manual API, captured error, and a real
    // window 'error' event (proves the global error handler wasn't installed).
    addBreadcrumb({ category: "test", message: "inactive" });
    setUser({ id: "u1" });
    captureError(new Error("inactive error"));
    window.dispatchEvent(new ErrorEvent("error", { message: "uncaught", filename: "a.js", lineno: 1 }));
    flush();

    expect(sentPayloads).toHaveLength(0);
  });

  it("active:false leaves the SDK uninitialized, so a later active init still works", () => {
    init({ key: "k1", active: false });
    // The off-switch must not latch `initialized` — otherwise a real init
    // after an env-gated no-op would be silently swallowed.
    init({ key: "k2", session: { enabled: true } });

    addBreadcrumb({ category: "test", message: "now active" });
    flush();

    const eventPayloads = sentPayloads.filter(p => p.url.includes("/ingest/browser"));
    expect(eventPayloads.length).toBeGreaterThan(0);
    expect(eventPayloads[0].url).toContain("api_key=k2");
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

  const errorBodies = () =>
    sentPayloads
      .filter((p) => p.url.includes("/ingest/browser/errors"))
      .map((p) => { try { return JSON.parse(p.body); } catch { return null; } })
      .filter(Boolean);

  it("reports console.error(string) as an error by default (errors.console)", () => {
    init({ key: "test-key" });

    const msg = "console boom " + Math.random();
    console.error(msg);

    const hit = errorBodies().find((b) => b.error.message === msg);
    expect(hit).toBeDefined();
    expect(hit.error.name).toBe("console.error");
  });

  it("console.error(Error) reports the passed Error, not a synthesized one", () => {
    init({ key: "test-key" });

    console.error("context:", new Error("real console error"));

    const hit = errorBodies().find((b) => b.error.message === "real console error");
    expect(hit).toBeDefined();
    expect(hit.error.name).toBe("Error");
  });

  it("errors.console:false keeps console.error a breadcrumb only, no report", () => {
    init({ key: "test-key", errors: { console: false }, session: { enabled: true } });

    const msg = "should not report " + Math.random();
    console.error(msg);
    flush();

    expect(errorBodies()).toHaveLength(0);
    // Still recorded as a console breadcrumb on the journey stream.
    const crumbs = sentPayloads
      .filter((p) => p.url.includes("/ingest/browser") && !p.url.includes("/errors"))
      .map((p) => { try { return JSON.parse(p.body); } catch { return null; } })
      .filter((b) => b?.type === "events")
      .flatMap((b) => b.breadcrumbs ?? []);
    expect(crumbs.find((c) => c.category === "console" && c.message.includes("should not report"))).toBeDefined();
  });

  it("still reports a console error whose stack is SDK-rooted (leading SDK frames stripped)", () => {
    // Without stripping, isOwnError would see "@appsignal/browser" in the stack
    // and drop it — which would silently break the feature in the built bundle
    // (tests otherwise never exercise this, since src paths lack the marker).
    init({ key: "test-key" });

    const err = new Error("sdk-stacked console error");
    err.stack = [
      "Error: sdk-stacked console error",
      "    at consoleArgsToError (webpack://@appsignal/browser/dist/esm/index.js:800:10)",
      "    at appCode (https://app.example.com/main.js:12:3)",
    ].join("\n");
    console.error(err);

    expect(errorBodies().find((b) => b.error.message === "sdk-stacked console error")).toBeDefined();
  });

  it("escalating a console.error does not recurse into extra reports", () => {
    init({ key: "test-key" });

    const msg = "single report " + Math.random();
    console.error(msg);

    expect(errorBodies().filter((b) => b.error.message === msg)).toHaveLength(1);
  });

  it("beforeError returning null drops a console error", () => {
    init({ key: "test-key", beforeError: (e) => /drop-me/.test(e.message) ? null : e });

    console.error("drop-me " + Math.random());

    expect(errorBodies().filter((b) => /drop-me/.test(b.error.message))).toHaveLength(0);
  });

  it("sampleRate:0 drops console errors too", () => {
    init({ key: "test-key", errors: { sampleRate: 0 } });

    console.error("sampled out " + Math.random());

    expect(errorBodies()).toHaveLength(0);
  });

  it("the SDK's own beforeError-Promise diagnostic is not escalated into a report", () => {
    // A non-console error whose beforeError returns a Promise makes handleError
    // log via console.error. That internal log must not become an escalated
    // console error. The hook deliberately PASSES console-sourced errors
    // through (so they'd reach the wire if unguarded) and only drops the
    // trigger — this way the test fails if the reentrancy guard is removed,
    // rather than the diagnostic being silently dropped by the hook itself.
    init({
      key: "test-key",
      beforeError: (e) => (e.context?.source === "console" ? e : (Promise.resolve(null) as never)),
    });

    captureError(new Error("triggers async-beforeError warning"));

    expect(errorBodies().some((b) => /beforeError returned a Promise/.test(b.error.message))).toBe(false);
  });

  it("reports a synthesized console error with a Firefox-shaped stack (no header line)", () => {
    // Firefox/Safari stacks have no "Error: msg" header — line 0 is the first
    // frame (the SDK interceptor). Regression guard for stripLeadingSdkFrames:
    // the leading SDK frame must still be stripped, or isOwnError drops the
    // whole error and the feature silently no-ops on those engines.
    init({ key: "test-key" });

    const err = new Error("ff console error");
    err.stack = [
      "consoleArgsToError@webpack://@appsignal/browser/dist/esm/browser.esm.js:800:10",
      "appCode@https://app.example.com/main.js:12:3",
    ].join("\n");
    console.error(err);

    const hit = errorBodies().find((b) => b.error.message === "ff console error");
    expect(hit).toBeDefined();
    // The SDK interceptor frame must be stripped from the shipped stack, and it
    // should root at the app frame — not just "reported vs dropped".
    expect(hit.error.backtrace.join("\n")).not.toContain("@appsignal/browser");
    expect(hit.error.backtrace[0]).toContain("app.example.com/main.js");
  });

  it("reports a console error whose message contains @host:port (no false stack-frame match)", () => {
    // Regression: a header line like "Error: connect wss://user@host:443 failed"
    // used to be misclassified as a frame. Console errors bypass isOwnError now,
    // so this must report regardless.
    init({ key: "test-key" });

    console.error("connect wss://user@host:443 failed at 10:30");

    expect(errorBodies().find((b) => /user@host:443/.test(b.error.message))).toBeDefined();
  });

  it("console.error with multiple Errors reports the first one", () => {
    init({ key: "test-key" });

    console.error(new Error("first err"), new Error("second err"));

    const bodies = errorBodies();
    expect(bodies.find((b) => b.error.message === "first err")).toBeDefined();
    expect(bodies.find((b) => b.error.message === "second err")).toBeUndefined();
  });

  it("console.error() with no args and non-serializable args don't throw and still report", () => {
    init({ key: "test-key" });

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => console.error()).not.toThrow();
    expect(() => console.error("s", circular, 10n, () => {})).not.toThrow();

    expect(errorBodies().length).toBeGreaterThan(0);
  });

  it("errors.console works when breadcrumbs.console is off (format-once branch)", () => {
    init({ key: "test-key", breadcrumbs: { console: false }, session: { enabled: true } });

    const msg = "no-crumb report " + Math.random();
    console.error(msg);
    flush();

    // Reported as an error...
    expect(errorBodies().find((b) => b.error.message === msg)).toBeDefined();
    // ...but no console breadcrumb was recorded (breadcrumbs.console off).
    const crumbs = sentPayloads
      .filter((p) => p.url.includes("/ingest/browser") && !p.url.includes("/errors"))
      .map((p) => { try { return JSON.parse(p.body); } catch { return null; } })
      .filter((b) => b?.type === "events")
      .flatMap((b) => b.breadcrumbs ?? []);
    expect(crumbs.some((c) => c.category === "console")).toBe(false);
  });

  it("reports a console error whose surviving stack still contains an SDK frame (isOwnError bypass)", () => {
    // Guards the load-bearing `fromConsole` bypass: this stack has an app frame
    // FIRST, so stripLeadingSdkFrames removes nothing and the SDK marker
    // survives — isOwnError would drop it if console errors didn't bypass it.
    // Fails iff the `!fromConsole &&` bypass is removed.
    init({ key: "test-key" });

    const err = new Error("interleaved sdk frame");
    err.stack = [
      "Error: interleaved sdk frame",
      "    at appCode (https://app.example.com/main.js:1:1)",
      "    at hook (https://cdn.example.com/@appsignal/browser/browser.esm.js:2:2)",
    ].join("\n");
    console.error(err);

    expect(errorBodies().find((b) => b.error.message === "interleaved sdk frame")).toBeDefined();
  });

  it("beforeError sees context.source==='console' for both string and Error console calls", () => {
    // Locks the documented filter: context.source is the reliable discriminator
    // for ALL console escalations, unlike error_class (which a passed Error keeps).
    const sources: unknown[] = [];
    init({ key: "test-key", beforeError: (e) => { sources.push(e.context?.source); return e; } });

    console.error("string console");
    console.error(new Error("error console"));

    expect(sources.filter((s) => s === "console")).toHaveLength(2);
  });

  it("truncates a huge synthesized console message", () => {
    init({ key: "test-key" });

    console.error("x".repeat(10000));

    const hit = errorBodies().find((b) => /^x+$/.test(b.error.message));
    expect(hit).toBeDefined();
    expect(hit.error.message.length).toBeLessThanOrEqual(2000);
  });

  it("destroy() unpatches console.error so it no longer reports", () => {
    init({ key: "test-key" });
    destroy();
    sentPayloads = [];

    console.error("after destroy " + Math.random());

    expect(errorBodies()).toHaveLength(0);
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

  it("error tags are exactly what setTags set; setUser does not tag errors", () => {
    init({ key: "test-key" });
    // setUser identifies the user (session stream) but must NOT appear on errors.
    setUser({ id: "u1", email: "test@test.com" });
    setTags({ plan: "pro", org_id: "acme" });

    captureError(new Error("tagged"));

    const errorPayloads = sentPayloads
      .filter((p) => p.url.includes("/ingest/browser/errors"))
      .map((p) => { try { return JSON.parse(p.body); } catch { return null; } })
      .filter((b) => !!b);
    expect(errorPayloads.length).toBeGreaterThan(0);

    // Only setTags values — no SDK identity, no setUser fields.
    expect(errorPayloads[0].tags).toEqual({ plan: "pro", org_id: "acme" });
  });

  it("clearTags drops error tags from subsequent payloads", () => {
    init({ key: "test-key" });
    setTags({ plan: "pro" });
    clearTags();

    captureError(new Error("after clear"));

    const errorPayloads = sentPayloads
      .filter((p) => p.url.includes("/ingest/browser/errors"))
      .map((p) => { try { return JSON.parse(p.body); } catch { return null; } })
      .filter((b) => !!b);
    expect(errorPayloads.length).toBeGreaterThan(0);
    expect(errorPayloads[0].tags).toEqual({});
  });
});
