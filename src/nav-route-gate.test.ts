import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
    onFCP: record("fcp"),
    onTTFB: record("ttfb"),
    onCLS: record("cls"),
    onINP: record("inp"),
  };
});

// Imported dynamically per test after vi.resetModules() — the once-per-page
// web-vitals registration guard otherwise leaks across test files.
type SdkModule = typeof import("./index.js");

function eventVitals(sent: { body: string }[]) {
  return sent
    .map((p) => {
      try {
        return JSON.parse(p.body);
      } catch {
        return null;
      }
    })
    .filter((b) => b?.type === "events")
    .flatMap((e) => e.vitals ?? []);
}

describe("navigation route-key gating", () => {
  let sent: { url: string; body: string }[] = [];

  let sdk: SdkModule;

  beforeEach(async () => {
    sent = [];
    vi.resetModules();
    for (const k of Object.keys(handlers)) delete handlers[k];
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, opts) => {
      sent.push({ url: String(_url), body: String(opts?.body || "") });
      return Promise.resolve(new Response(null, { status: 200 }));
    });
    sessionStorage.clear();
    localStorage.clear();
    history.replaceState({}, "", "/a");
    sdk = await import("./index.js");
  });

  afterEach(() => {
    sdk.destroy();
    history.replaceState({}, "", "/");
    vi.restoreAllMocks();
  });

  it("ignores a same-path history update so load metrics still get the route template", () => {
    sdk.init({ key: "k" });
    handlers.ttfb({ name: "TTFB", value: 120, entries: [{ startTime: 40 }] });
    history.replaceState({}, "", "/a?normalized=1");
    sdk.setRouteTemplate("/sites/:id");
    history.pushState({}, "", "/b");

    const ttfb = eventVitals(sent).find((v: { name: string }) => v.name === "TTFB");
    expect(ttfb?.page_url).toBe("/sites/:id");
  });

  it("treats a real path change as a route boundary", () => {
    sdk.init({ key: "k" });
    const landingHref = location.href;
    handlers.ttfb({ name: "TTFB", value: 90, entries: [{ startTime: 10 }] });
    history.pushState({}, "", "/b");

    const ttfb = eventVitals(sent).find((v: { name: string }) => v.name === "TTFB");
    expect(ttfb?.page_url).toBe(landingHref);
  });
});
