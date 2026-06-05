import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Capture the handlers web-vitals would invoke so tests can drive them
// directly. vi.hoisted() gives us a store that's safe to reference inside
// the hoisted vi.mock factory below.
const { handlers } = vi.hoisted(() => {
  const handlers: Record<string, { cb: (m: Record<string, unknown>) => void; opts?: { reportAllChanges?: boolean } }> = {};
  return { handlers };
});

vi.mock("web-vitals", () => {
  const record = (name: string) => (cb: (m: Record<string, unknown>) => void, opts?: { reportAllChanges?: boolean }) => {
    handlers[name] = { cb, opts };
  };
  return {
    onLCP: record("lcp"),
    onCLS: record("cls"),
    onINP: record("inp"),
    onFCP: record("fcp"),
    onTTFB: record("ttfb"),
  };
});

import { initVitals, drainVitals, destroyVitals, setRouteTemplate, markVitalsNavigation } from "./vitals.js";

// The reporters read name, value, and entries[].startTime off the metric.
// `startTime` is the performance entry's time-from-navigation; tests that
// don't care about the timestamp omit it (occurredAt falls back to now).
function fakeLCP(value: number, startTime?: number) {
  return { name: "LCP", value, entries: startTime == null ? [] : [{ startTime }] };
}
function fakeCLS(value: number) {
  return { name: "CLS", value, entries: [] };
}
function fakeINP(value: number) {
  return { name: "INP", value, entries: [] };
}

function setLocation(href: string) {
  Object.defineProperty(window, "location", {
    value: new URL(href),
    configurable: true,
  });
}

describe("vitals", () => {
  beforeEach(() => {
    for (const k of Object.keys(handlers)) delete handlers[k];
    setLocation("https://example.com/");
  });

  afterEach(() => {
    destroyVitals();
  });

  describe("reportAllChanges + dedupe", () => {
    it("registers LCP, CLS, and INP with reportAllChanges", () => {
      initVitals([]);
      expect(handlers.lcp.opts).toEqual({ reportAllChanges: true });
      expect(handlers.cls.opts).toEqual({ reportAllChanges: true });
      expect(handlers.inp.opts).toEqual({ reportAllChanges: true });
    });

    it("does not set reportAllChanges for FCP and TTFB", () => {
      // Both fire once, early — they don't need the dedupe flow.
      initVitals([]);
      expect(handlers.fcp.opts).toBeUndefined();
      expect(handlers.ttfb.opts).toBeUndefined();
    });

    it("stamps the metric with its occurrence time, not the report time", () => {
      // web-vitals can report a metric long after it occurred (e.g. LCP
      // finalising at page-hide). The timestamp must reflect when the entry
      // happened — performance.timeOrigin + entry.startTime — so the server
      // buckets it into the right minute regardless of when the callback ran.
      initVitals([]);
      handlers.lcp.cb(fakeLCP(2400, 1500));
      const lcp = drainVitals().find((v) => v.name === "LCP");
      expect(lcp?.timestamp).toBe(Math.round(performance.timeOrigin + 1500));
    });

    it("keeps only the latest LCP value for the same page", () => {
      initVitals([]);
      handlers.lcp.cb(fakeLCP(1200));
      handlers.lcp.cb(fakeLCP(2500));
      handlers.lcp.cb(fakeLCP(3000));
      const lcps = drainVitals().filter(v => v.name === "LCP");
      expect(lcps).toHaveLength(1);
      expect(lcps[0].value).toBe(3000);
    });

    it("keeps separate entries per page_url", () => {
      // Uses INP, a current-route metric, since the dedupe key is
      // (name, page_url). (Load metrics like LCP are frozen to the initial
      // route — see "SPA route attribution".)
      initVitals([]);
      setLocation("https://example.com/a");
      handlers.inp.cb(fakeINP(150));
      setLocation("https://example.com/b");
      handlers.inp.cb(fakeINP(250));

      const inps = drainVitals().filter(v => v.name === "INP");
      expect(inps).toHaveLength(2);
      const byUrl = new Map(inps.map(v => [v.page_url, v.value]));
      expect(byUrl.get("https://example.com/a")).toBe(150);
      expect(byUrl.get("https://example.com/b")).toBe(250);
    });

    it("applies dedupe independently to CLS and INP", () => {
      initVitals([]);
      handlers.cls.cb(fakeCLS(0.05));
      handlers.cls.cb(fakeCLS(0.35));
      handlers.inp.cb(fakeINP(150));
      handlers.inp.cb(fakeINP(820));

      const vitals = drainVitals();
      const cls = vitals.filter(v => v.name === "CLS");
      const inp = vitals.filter(v => v.name === "INP");
      expect(cls).toHaveLength(1);
      expect(cls[0].value).toBe(0.35);
      expect(inp).toHaveLength(1);
      expect(inp[0].value).toBe(820);
    });
  });

  describe("destroyed state", () => {
    it("ignores callbacks after destroyVitals()", () => {
      initVitals([]);
      destroyVitals();
      handlers.lcp.cb(fakeLCP(5000));
      expect(drainVitals()).toHaveLength(0);
    });
  });

  describe("per-SPA-page CLS attribution", () => {
    // web-vitals reports CLS as a cumulative value across the whole
    // page-view. Without baseline subtraction, CLS@B reported after a soft
    // nav would include shifts that happened on A. markVitalsNavigation
    // captures the cumulative value at each route change so subsequent
    // CLS fires report the per-route delta.

    it("subtracts the pre-navigation cumulative CLS from new fires", async () => {
      const { markVitalsNavigation } = await import("./vitals.js");
      initVitals([]);

      // Two shifts on /a: pre-navigation cumulative = 0.08.
      setLocation("https://example.com/a");
      handlers.cls.cb(fakeCLS(0.05));
      handlers.cls.cb(fakeCLS(0.08));

      // Simulate the SPA navigation hook firing: outgoing entries flush,
      // then markVitalsNavigation locks in baseline=0.08.
      drainVitals();
      markVitalsNavigation();

      // Two more shifts on /b: web-vitals continues to report cumulative
      // (0.12, 0.14). Per-page values should be 0.04 and 0.06.
      setLocation("https://example.com/b");
      handlers.cls.cb(fakeCLS(0.12));
      handlers.cls.cb(fakeCLS(0.14));

      const cls = drainVitals().filter((v) => v.name === "CLS");
      expect(cls).toHaveLength(1);
      expect(cls[0].value).toBeCloseTo(0.06, 5);
      expect(cls[0].page_url).toBe("https://example.com/b");
    });

    it("reports only the per-page delta even when the prior route accrued a large CLS", async () => {
      const { markVitalsNavigation } = await import("./vitals.js");
      initVitals([]);

      // /a accrues a large cumulative CLS (0.4).
      setLocation("https://example.com/a");
      handlers.cls.cb(fakeCLS(0.4));
      drainVitals();
      markVitalsNavigation();

      // A tiny shift on /b (0.02 delta) reports as 0.02, not /a's cumulative.
      setLocation("https://example.com/b");
      handlers.cls.cb(fakeCLS(0.42));
      const cls = drainVitals().filter((v) => v.name === "CLS");
      expect(cls[0].value).toBeCloseTo(0.02, 5);
    });

    it("clamps to zero when cumulative briefly regresses (defensive)", async () => {
      // web-vitals never lowers CLS in practice, but a buggy or test-injected
      // metric value below the baseline would otherwise produce a negative
      // page-level entry. Clamp at 0 so charts don't break.
      const { markVitalsNavigation } = await import("./vitals.js");
      initVitals([]);
      handlers.cls.cb(fakeCLS(0.1));
      drainVitals();
      markVitalsNavigation();
      handlers.cls.cb(fakeCLS(0.08));
      const cls = drainVitals().filter((v) => v.name === "CLS");
      expect(cls[0].value).toBe(0);
    });
  });

  describe("setRouteTemplate", () => {
    // The host app is expected to call setRouteTemplate on every router
    // navigation so the server can aggregate by route shape (e.g.
    // `/users/:id`) instead of by raw URL. When set, we ship the
    // template as `page_url`. Without it the SDK sends `location.href`
    // and the server auto-templates it.

    it("sends the template as page_url when set", async () => {
      const { setRouteTemplate } = await import("./vitals.js");
      initVitals([]);
      setRouteTemplate("/users/:id");

      setLocation("https://example.com/users/42");
      handlers.lcp.cb(fakeLCP(2400));

      const lcp = drainVitals().filter((v) => v.name === "LCP");
      expect(lcp).toHaveLength(1);
      // The template wins — the raw URL doesn't go on the wire.
      expect(lcp[0].page_url).toBe("/users/:id");
    });

    it("sends location.href as page_url when no template is set", async () => {
      initVitals([]);
      setLocation("https://example.com/users/42");
      handlers.lcp.cb(fakeLCP(1800));
      const lcp = drainVitals().filter((v) => v.name === "LCP");
      // Server will auto-template this on ingest.
      expect(lcp[0].page_url).toBe("https://example.com/users/42");
    });

    it("clears the template when passed null (subsequent reports fall back to location.href)", async () => {
      const { setRouteTemplate } = await import("./vitals.js");
      initVitals([]);
      setLocation("https://example.com/users/42");
      setRouteTemplate("/users/:id");
      handlers.lcp.cb(fakeLCP(2400));

      setRouteTemplate(null);
      setLocation("https://example.com/orders/99");
      handlers.inp.cb(fakeINP(180));

      const drained = drainVitals();
      const lcp = drained.find((v) => v.name === "LCP");
      const inp = drained.find((v) => v.name === "INP");
      expect(lcp?.page_url).toBe("/users/:id");
      expect(inp?.page_url).toBe("https://example.com/orders/99");
    });

    it("applies to CLS entries too (uses the same currentRouteTemplate)", async () => {
      const { setRouteTemplate } = await import("./vitals.js");
      initVitals([]);
      setRouteTemplate("/checkout");
      handlers.cls.cb(fakeCLS(0.05));
      const cls = drainVitals().filter((v) => v.name === "CLS");
      expect(cls[0].page_url).toBe("/checkout");
    });

    it("resets when initVitals is called again (next session)", async () => {
      const { setRouteTemplate } = await import("./vitals.js");
      initVitals([]);
      setRouteTemplate("/users/:id");
      destroyVitals();

      initVitals([]);
      setLocation("https://example.com/users/42");
      handlers.lcp.cb(fakeLCP(1500));
      const lcp = drainVitals().filter((v) => v.name === "LCP");
      // Fresh init() resets internal state — the previous template
      // must not leak across SDK lifecycles.
      expect(lcp[0].page_url).toBe("https://example.com/users/42");
    });
  });

  describe("SPA route attribution", () => {
    // LCP/FCP/TTFB are load metrics: a late update reported *after* a navigation
    // must stay on the initial route (per the Core Web Vitals spec, the
    // largest-contentful-paint stream belongs to the initial navigation). The
    // SDK freezes load-metric attribution to the first-reported route.
    it("late LCP update after navigation stays on the initial route", () => {
      initVitals([]);
      setRouteTemplate("/a");
      handlers.lcp.cb(fakeLCP(1000));
      const onA = drainVitals(); // simulates the flush-on-navigation for /a
      expect(onA.find((v) => v.name === "LCP")?.page_url).toBe("/a");

      // Navigate /a -> /b, then a larger LCP candidate fires *after* the nav
      // (e.g. a programmatic nav that didn't involve an interaction, so LCP
      // measurement wasn't frozen).
      setRouteTemplate("/b");
      markVitalsNavigation();
      handlers.lcp.cb(fakeLCP(1500));
      const after = drainVitals();
      const lateLcp = after.find((v) => v.name === "LCP");

      // LCP belongs to the initial load — the late candidate must not be
      // re-attributed to /b.
      expect(lateLcp?.page_url).toBe("/a");
    });
  });
});
