import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// web-vitals now supplies only the load metrics (LCP/FCP/TTFB). Capture the
// callbacks it registers so tests can drive them directly.
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
    // CLS/INP are no longer sourced from web-vitals (the SDK observes raw
    // performance entries instead), but keep the exports so the import resolves.
    onCLS: record("cls"),
    onINP: record("inp"),
  };
});

import {
  initVitals,
  drainVitals,
  destroyVitals,
  finalizeRouteVitals,
  markVitalsNavigation,
  setRouteTemplate,
} from "./vitals.js";

// --- PerformanceObserver mock: route entries to whoever observed the type ---
const observers: Record<string, (entries: unknown[]) => void> = {};

class MockPerformanceObserver {
  static supportedEntryTypes = ["layout-shift", "event", "first-input", "largest-contentful-paint"];
  private cb: (list: { getEntries: () => unknown[] }) => void;
  constructor(cb: (list: { getEntries: () => unknown[] }) => void) {
    this.cb = cb;
  }
  observe(opts: { type: string }) {
    observers[opts.type] = (entries: unknown[]) => this.cb({ getEntries: () => entries });
  }
  disconnect() {}
}

function emitShifts(entries: Array<{ value: number; startTime: number; hadRecentInput?: boolean }>) {
  observers["layout-shift"]?.(entries.map((e) => ({ hadRecentInput: false, ...e })));
}
function emitInteractions(entries: Array<{ interactionId: number; duration: number; startTime: number }>) {
  observers["event"]?.(entries.map((e) => ({ entryType: "event", ...e })));
}

function fakeLoad(name: string, value: number, startTime?: number) {
  return { name, value, entries: startTime == null ? [] : [{ startTime }] };
}

function setLocation(href: string) {
  Object.defineProperty(window, "location", { value: new URL(href), configurable: true });
}

describe("vitals", () => {
  beforeEach(() => {
    for (const k of Object.keys(handlers)) delete handlers[k];
    for (const k of Object.keys(observers)) delete observers[k];
    vi.stubGlobal("PerformanceObserver", MockPerformanceObserver);
    setLocation("https://example.com/");
  });

  afterEach(() => {
    destroyVitals();
    vi.unstubAllGlobals();
  });

  describe("load metrics (LCP/FCP/TTFB)", () => {
    it("registers a callback for each load metric", () => {
      // reportAllChanges is a debug-only mode web-vitals advises against in
      // production; the load metrics are reported once, at finalisation.
      initVitals([]);
      expect(typeof handlers.lcp).toBe("function");
      expect(typeof handlers.fcp).toBe("function");
      expect(typeof handlers.ttfb).toBe("function");
    });

    it("stamps the metric with its occurrence time, not the report time", () => {
      initVitals([]);
      handlers.lcp(fakeLoad("LCP", 2400, 1500));
      const lcp = drainVitals().find((v) => v.name === "LCP");
      expect(lcp?.timestamp).toBe(Math.round(performance.timeOrigin + 1500));
    });

    it("attributes all three load metrics to one frozen load route", () => {
      // The load route freezes on first use and is shared, so a late metric
      // can't diverge from an early one even across a navigation.
      initVitals([]);
      setRouteTemplate("/landing");
      handlers.ttfb(fakeLoad("TTFB", 100));
      // navigate away before LCP finalises
      setRouteTemplate("/next");
      markVitalsNavigation();
      handlers.lcp(fakeLoad("LCP", 2400));

      const byName = new Map(drainVitals().map((v) => [v.name, v.page_url]));
      expect(byName.get("TTFB")).toBe("/landing");
      expect(byName.get("LCP")).toBe("/landing");
    });

    it("falls back to the scrubbed URL when no template is set", () => {
      initVitals([]);
      setLocation("https://example.com/users/42");
      handlers.lcp(fakeLoad("LCP", 1800));
      expect(drainVitals().find((v) => v.name === "LCP")?.page_url).toBe(
        "https://example.com/users/42",
      );
    });
  });

  describe("CLS (per route, session-window)", () => {
    it("reports the largest session window for the route", () => {
      initVitals([]);
      // One window: 0.05 + 0.03 = 0.08 (gaps < 1s, span < 5s).
      emitShifts([
        { value: 0.05, startTime: 100 },
        { value: 0.03, startTime: 600 },
      ]);
      // New window after a >1s gap; smaller, so the max stays 0.08.
      emitShifts([{ value: 0.02, startTime: 2000 }]);
      finalizeRouteVitals();
      const cls = drainVitals().find((v) => v.name === "CLS");
      expect(cls?.value).toBeCloseTo(0.08, 5);
    });

    it("ignores shifts that had recent input", () => {
      initVitals([]);
      emitShifts([
        { value: 0.05, startTime: 100, hadRecentInput: true },
        { value: 0.02, startTime: 200 },
      ]);
      finalizeRouteVitals();
      expect(drainVitals().find((v) => v.name === "CLS")?.value).toBeCloseTo(0.02, 5);
    });

    it("does not emit CLS when there were no shifts", () => {
      initVitals([]);
      finalizeRouteVitals();
      expect(drainVitals().find((v) => v.name === "CLS")).toBeUndefined();
    });

    it("measures each route independently across a navigation", () => {
      initVitals([]);
      setRouteTemplate("/a");
      emitShifts([{ value: 0.4, startTime: 100 }]);
      finalizeRouteVitals();
      const a = drainVitals().find((v) => v.name === "CLS");
      expect(a?.value).toBeCloseTo(0.4, 5);
      expect(a?.page_url).toBe("/a");

      // Navigate: reset observers, new route starts from zero.
      markVitalsNavigation();
      setRouteTemplate("/b");
      emitShifts([{ value: 0.02, startTime: 5000 }]);
      finalizeRouteVitals();
      const b = drainVitals().find((v) => v.name === "CLS");
      // /b's CLS reflects only /b's shift, not /a's accrued 0.4.
      expect(b?.value).toBeCloseTo(0.02, 5);
      expect(b?.page_url).toBe("/b");
    });

    it("stamps CLS at the last shift's occurrence time", () => {
      initVitals([]);
      emitShifts([{ value: 0.05, startTime: 800 }]);
      finalizeRouteVitals();
      expect(drainVitals().find((v) => v.name === "CLS")?.timestamp).toBe(
        Math.round(performance.timeOrigin + 800),
      );
    });
  });

  describe("INP (per route, worst interaction)", () => {
    it("reports the worst interaction latency for the route", () => {
      initVitals([]);
      emitInteractions([
        { interactionId: 1, duration: 120, startTime: 100 },
        { interactionId: 2, duration: 350, startTime: 200 },
        { interactionId: 3, duration: 80, startTime: 300 },
      ]);
      finalizeRouteVitals();
      expect(drainVitals().find((v) => v.name === "INP")?.value).toBe(350);
    });

    it("takes the longest event within a single interaction", () => {
      initVitals([]);
      // keydown + keyup share one interactionId; the interaction latency is the
      // longer of the two.
      emitInteractions([
        { interactionId: 7, duration: 90, startTime: 100 },
        { interactionId: 7, duration: 210, startTime: 140 },
      ]);
      finalizeRouteVitals();
      expect(drainVitals().find((v) => v.name === "INP")?.value).toBe(210);
    });

    it("measures each route independently across a navigation", () => {
      initVitals([]);
      setRouteTemplate("/a");
      emitInteractions([{ interactionId: 1, duration: 500, startTime: 100 }]);
      finalizeRouteVitals();
      expect(drainVitals().find((v) => v.name === "INP")?.value).toBe(500);

      markVitalsNavigation();
      setRouteTemplate("/b");
      emitInteractions([{ interactionId: 2, duration: 120, startTime: 200 }]);
      finalizeRouteVitals();
      const b = drainVitals().find((v) => v.name === "INP");
      expect(b?.value).toBe(120);
      expect(b?.page_url).toBe("/b");
    });

    it("does not emit INP when there were no interactions", () => {
      initVitals([]);
      finalizeRouteVitals();
      expect(drainVitals().find((v) => v.name === "INP")).toBeUndefined();
    });
  });

  describe("destroyed state", () => {
    it("ignores entries and load callbacks after destroyVitals()", () => {
      initVitals([]);
      destroyVitals();
      handlers.lcp(fakeLoad("LCP", 5000));
      emitShifts([{ value: 0.5, startTime: 100 }]);
      emitInteractions([{ interactionId: 1, duration: 900, startTime: 100 }]);
      finalizeRouteVitals();
      expect(drainVitals()).toHaveLength(0);
    });
  });

  describe("setRouteTemplate", () => {
    it("ships the template as page_url for per-route metrics", () => {
      initVitals([]);
      setRouteTemplate("/checkout");
      emitShifts([{ value: 0.05, startTime: 100 }]);
      finalizeRouteVitals();
      expect(drainVitals().find((v) => v.name === "CLS")?.page_url).toBe("/checkout");
    });

    it("falls back to location.href when cleared with null", () => {
      initVitals([]);
      setRouteTemplate("/checkout");
      setRouteTemplate(null);
      setLocation("https://example.com/orders/99");
      emitInteractions([{ interactionId: 1, duration: 180, startTime: 100 }]);
      finalizeRouteVitals();
      expect(drainVitals().find((v) => v.name === "INP")?.page_url).toBe(
        "https://example.com/orders/99",
      );
    });

    it("resets internal state when initVitals is called again", () => {
      initVitals([]);
      setRouteTemplate("/users/:id");
      destroyVitals();

      initVitals([]);
      setLocation("https://example.com/users/42");
      handlers.lcp(fakeLoad("LCP", 1500));
      // Fresh init must not leak the previous template.
      expect(drainVitals().find((v) => v.name === "LCP")?.page_url).toBe(
        "https://example.com/users/42",
      );
    });
  });
});
