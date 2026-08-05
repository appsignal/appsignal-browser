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
  let sent: { url: string; body: string }[] = [];
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
      sent.push({ url: String(url), body: String(init?.body || "") });
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
});
