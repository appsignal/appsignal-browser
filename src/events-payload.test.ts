import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Capture the web-vitals handlers so a vital can be driven without a browser.
const { handlers } = vi.hoisted(() => {
  const handlers: Record<string, (m: Record<string, unknown>) => void> = {};
  return { handlers };
});
vi.mock("web-vitals", () => {
  const record = (name: string) => (cb: (m: Record<string, unknown>) => void) => {
    handlers[name] = cb;
  };
  return {
    onLCP: record("lcp"),
    onCLS: record("cls"),
    onINP: record("inp"),
    onFCP: record("fcp"),
    onTTFB: record("ttfb"),
  };
});

// Imported dynamically per test after vi.resetModules(), because the
// once-per-page web-vitals registration guard in vitals.ts would otherwise
// leave the second test with no handlers to drive.
type SdkModule = typeof import("./index.js");

// The shape of the `events` payload is a wire contract with the ingest
// endpoint, so pin the whole top-level key set rather than the fields a
// single test happens to care about. A field added or renamed here changes
// what the server deserializes, and that should be a deliberate edit to this
// test rather than something that slips through unnoticed.
describe("events payload shape", () => {
  let sent: { url: string; body: string; traceparent?: string }[] = [];
  let sdk: SdkModule;

  function eventsBodies() {
    return sent
      .filter((p) => p.url.includes("/ingest/browser") && !p.url.includes("/errors"))
      .map((p) => {
        try {
          return JSON.parse(p.body);
        } catch {
          return null;
        }
      })
      .filter((b) => b?.type === "events");
  }

  beforeEach(async () => {
    sent = [];
    vi.resetModules();
    for (const k of Object.keys(handlers)) delete handlers[k];
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      sent.push({
        url: String(url),
        body: String(init?.body || ""),
        traceparent: new Headers(init?.headers).get("traceparent") ?? undefined,
      });
      return Promise.resolve(new Response(null, { status: 200 }));
    });
    sessionStorage.clear();
    localStorage.clear();
    sdk = await import("./index.js");
  });

  afterEach(() => {
    sdk.destroy();
    vi.restoreAllMocks();
  });

  it("carries exactly type, session, breadcrumbs, vitals and app_version", () => {
    sdk.init({ key: "k", appVersion: "1.2.3", session: { enabled: true } });

    handlers.lcp({ name: "LCP", value: 2000, entries: [{ startTime: 100 }] });
    sdk.addBreadcrumb({ category: "test", message: "tick" });
    sdk.flush();

    const bodies = eventsBodies();
    expect(bodies).toHaveLength(1);

    const body = bodies[0];
    expect(Object.keys(body).sort()).toEqual([
      "app_version",
      "breadcrumbs",
      "session",
      "type",
      "vitals",
    ]);
    expect(body.type).toBe("events");
    expect(body.app_version).toBe("1.2.3");
    expect(body.session.session_id).toBeTruthy();
    expect(body.breadcrumbs.some((b: { category: string }) => b.category === "test")).toBe(true);
    expect(body.vitals).toEqual([
      { name: "LCP", value: 2000, page_url: expect.any(String), timestamp: expect.any(Number) },
    ]);
  });

  it("omits app_version when the host set none, and sends no breadcrumbs by default", () => {
    // Session streaming is off by default, so the journey stream is withheld
    // and only the vitals array carries anything.
    sdk.init({ key: "k" });

    handlers.ttfb({ name: "TTFB", value: 120, entries: [{ startTime: 40 }] });
    sdk.flush();

    const bodies = eventsBodies();
    expect(bodies).toHaveLength(1);

    const body = bodies[0];
    // `app_version` is set to undefined, which JSON.stringify drops, so the
    // key is absent from the wire body entirely.
    expect(Object.keys(body).sort()).toEqual(["breadcrumbs", "session", "type", "vitals"]);
    expect(body.breadcrumbs).toEqual([]);
    expect(body.vitals).toHaveLength(1);
  });

  it("closes the page load span the navigation declared", async () => {
    sdk.init({ key: "k", tracePropagationTargets: ["**/api/**"] });

    // A propagated request declares the span, which the boundary post closes.
    await fetch("http://localhost/api/orders");

    handlers.ttfb({ name: "TTFB", value: 120, entries: [{ startTime: 40 }] });
    const beforeFlush = Date.now();
    sdk.flush();

    const declared = sent
      .map((p) => {
        try {
          return JSON.parse(p.body);
        } catch {
          return null;
        }
      })
      .find((b) => b?.type === "page_load");
    const traceparent = sent.find((p) => p.traceparent)?.traceparent;
    const [, traceFromHeader, spanFromHeader] = traceparent!.split("-");

    // Everything that describes this span agrees on its identity, which is what
    // lets the server fold the rows into one span.
    expect(declared).toEqual({
      type: "page_load",
      trace_id: traceFromHeader,
      span_id: spanFromHeader,
      action: location.pathname,
      start_time: expect.any(Number),
      tags: {},
    });

    const body = eventsBodies().at(-1)!;
    // The closing object repeats everything the declaring post already sent,
    // alongside its own end time. These used to be left off deliberately; the
    // freeze already guarantees they agree, so leaving them off just meant a
    // lost page_load post left a span with no action and no tags at all.
    expect(body.page_load).toEqual({
      trace_id: traceFromHeader,
      span_id: spanFromHeader,
      start_time: declared.start_time,
      action: declared.action,
      end_time: expect.any(Number),
      tags: {},
    });
    expect(body.page_load.end_time).toBeGreaterThanOrEqual(beforeFlush);
  });

  it("carries tags set after the declaring post already went out", async () => {
    // Any single delivery can be the only one that arrives, so each carries as
    // complete a picture as it can. Tags are the one part that genuinely
    // changes during a navigation, so the closing post reads them fresh rather
    // than repeating what the declaring post sent. The server unions tags
    // across the span's rows, so the earlier ones are not lost either.
    sdk.init({ key: "k", tracePropagationTargets: ["**/api/**"] });
    sdk.setTags({ plan: "pro" });

    await fetch("http://localhost/api/orders");

    const declared = sent
      .map((p) => {
        try {
          return JSON.parse(p.body);
        } catch {
          return null;
        }
      })
      .find((b) => b?.type === "page_load");
    expect(declared.tags).toEqual({ plan: "pro" });

    // Set after the span was declared, so only the closing post can carry it.
    sdk.setTags({ checkout_step: "payment" });
    sdk.flush();

    expect(eventsBodies().at(-1)!.page_load.tags).toEqual({
      plan: "pro",
      checkout_step: "payment",
    });
  });

  it("sends the closing post even with no vitals or breadcrumbs, so a known end time is not lost", async () => {
    // flushEvents used to return early whenever there were no vitals and no
    // breadcrumbs (breadcrumbs only ship with session streaming, off by
    // default). A navigation that declared a page load span but produced no
    // vitals would then send no closing post at all, losing an end time the
    // library actually knew. A pending closing object is now reason enough on
    // its own for the post to go out.
    sdk.init({ key: "k", tracePropagationTargets: ["**/api/**"] });

    await fetch("http://localhost/api/orders");

    const beforeFlush = Date.now();
    sdk.flush();

    const body = eventsBodies().at(-1);
    expect(body).toBeTruthy();
    expect(body.vitals).toEqual([]);
    expect(body.breadcrumbs).toEqual([]);
    expect(body.page_load.end_time).toBeGreaterThanOrEqual(beforeFlush);
  });

  it("carries the host's serviceName on the page_load post and the closing object", async () => {
    sdk.init({
      key: "k",
      tracePropagationTargets: ["**/api/**"],
      serviceName: "checkout",
    });

    await fetch("http://localhost/api/orders");
    handlers.ttfb({ name: "TTFB", value: 120, entries: [{ startTime: 40 }] });
    sdk.flush();

    const declared = sent
      .map((p) => {
        try {
          return JSON.parse(p.body);
        } catch {
          return null;
        }
      })
      .find((b) => b?.type === "page_load");
    expect(declared.service_name).toBe("checkout");

    const body = eventsBodies().at(-1)!;
    expect(body.page_load.service_name).toBe("checkout");
  });

  it("carries no page_load when nothing propagated a traceparent", async () => {
    // Tracing is configured, but this navigation made no matching request, so
    // there is no span to declare and nothing to close.
    sdk.init({ key: "k", tracePropagationTargets: ["**/api/**"] });

    await fetch("http://localhost/static/logo.svg");

    handlers.ttfb({ name: "TTFB", value: 120, entries: [{ startTime: 40 }] });
    sdk.flush();

    const body = eventsBodies().at(-1)!;
    expect("page_load" in body).toBe(false);
  });
});
