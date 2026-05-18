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

  describe("reporting", () => {
    it("registers all five metrics with default options", () => {
      initVitals([]);
      expect(handlers.lcp.opts).toBeUndefined();
      expect(handlers.cls.opts).toBeUndefined();
      expect(handlers.inp.opts).toBeUndefined();
      expect(handlers.fcp.opts).toBeUndefined();
      expect(handlers.ttfb.opts).toBeUndefined();
    });

    it("pushes one entry per callback with the expected shape", () => {
      initVitals([]);
      handlers.lcp.cb(fakeLCP(2500));
      handlers.cls.cb(fakeCLS(0.1));
      handlers.inp.cb(fakeINP(200));

      const vitals = drainVitals();
      expect(vitals).toHaveLength(3);
      const lcp = vitals.find(v => v.name === "web.vital.lcp")!;
      expect(lcp.value).toBe(2500);
      expect(lcp.page_url).toBe("https://example.com/");
      expect(lcp.element).toBe("h1");
      expect(vitals.find(v => v.name === "web.vital.inp")!.interaction_type).toBe("pointer");
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
