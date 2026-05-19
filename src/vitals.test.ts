import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Capture the handlers web-vitals would invoke so tests can drive them
// directly. vi.hoisted() gives us a store that's safe to reference inside
// the hoisted vi.mock factory below.
const { handlers } = vi.hoisted(() => {
  const handlers: Record<string, { cb: (m: Record<string, unknown>) => void; opts?: { reportAllChanges?: boolean } }> = {};
  return { handlers };
});

vi.mock("web-vitals/attribution", () => {
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

import { initVitals, drainVitals, destroyVitals } from "./vitals.js";

function fakeLCP(value: number) {
  return { name: "LCP", value, rating: "good", attribution: { element: "h1" } };
}
function fakeCLS(value: number) {
  return { name: "CLS", value, rating: "good", attribution: { largestShiftTarget: "div" } };
}
function fakeINP(value: number) {
  return { name: "INP", value, rating: "good", attribution: { interactionTarget: "button", interactionType: "pointer" } };
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

    it("keeps only the latest LCP value for the same page", () => {
      initVitals([]);
      handlers.lcp.cb(fakeLCP(1200));
      handlers.lcp.cb(fakeLCP(2500));
      handlers.lcp.cb(fakeLCP(3000));
      const lcps = drainVitals().filter(v => v.name === "web.vital.lcp");
      expect(lcps).toHaveLength(1);
      expect(lcps[0].value).toBe(3000);
    });

    it("keeps separate entries per page_url", () => {
      initVitals([]);
      setLocation("https://example.com/a");
      handlers.lcp.cb(fakeLCP(1500));
      setLocation("https://example.com/b");
      handlers.lcp.cb(fakeLCP(2500));

      const lcps = drainVitals().filter(v => v.name === "web.vital.lcp");
      expect(lcps).toHaveLength(2);
      const byUrl = new Map(lcps.map(v => [v.page_url, v.value]));
      expect(byUrl.get("https://example.com/a")).toBe(1500);
      expect(byUrl.get("https://example.com/b")).toBe(2500);
    });

    it("applies dedupe independently to CLS and INP", () => {
      initVitals([]);
      handlers.cls.cb(fakeCLS(0.05));
      handlers.cls.cb(fakeCLS(0.35));
      handlers.inp.cb(fakeINP(150));
      handlers.inp.cb(fakeINP(820));

      const vitals = drainVitals();
      const cls = vitals.filter(v => v.name === "web.vital.cls");
      const inp = vitals.filter(v => v.name === "web.vital.inp");
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
});
