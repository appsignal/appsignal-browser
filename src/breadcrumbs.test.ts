import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  initBreadcrumbs,
  addBreadcrumb,
  addManualBreadcrumb,
  getSnapshot,
  drainBreadcrumbs,
  updateBreadcrumbConfig,
  clearBreadcrumbs,
} from "./breadcrumbs.js";
import { initNetworkHook, destroyNetworkHook } from "./network-hook.js";
import type { ServerConfig } from "./types.js";

vi.mock("./errors.js", () => ({
  getLastErrorTimestamp: vi.fn(() => 0),
}));

vi.mock("./tracing.js", () => ({
  consumeTraceId: vi.fn(() => undefined),
}));

const defaultBreadcrumbConfig: ServerConfig["breadcrumbs"] = {
  enabled: true,
  network: false,
  network_blocklist: [],
  query_params_allowlist: [],
  network_payloads: {
    enabled: false,
    request_body: true,
    response_body: true,
    max_size_bytes: 65536,
    content_types: ["application/json"],
  },
  console: false,
  clicks: false,
  long_tasks: false,
  scroll_depth: false,
  form_abandonment: false,
  user_timing: false,
  capacity: 100,
};

describe("breadcrumbs", () => {
  beforeEach(() => {
    initBreadcrumbs(defaultBreadcrumbConfig, "http://localhost/ingest/browser");
    clearBreadcrumbs();
  });

  it("stores and retrieves breadcrumbs", () => {
    addBreadcrumb({
      timestamp: Date.now(),
      category: "test",
      message: "hello",
    });

    const snapshot = getSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].category).toBe("test");
    expect(snapshot[0].message).toBe("hello");
  });

  it("addManualBreadcrumb adds timestamp automatically", () => {
    const before = Date.now();
    addManualBreadcrumb({ category: "manual", message: "test" });
    const after = Date.now();

    const snapshot = getSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(snapshot[0].timestamp).toBeLessThanOrEqual(after);
  });

  it("respects capacity limit", () => {
    initBreadcrumbs(
      { ...defaultBreadcrumbConfig, capacity: 3 },
      "http://localhost/ingest/browser",
    );

    for (let i = 0; i < 5; i++) {
      addBreadcrumb({ timestamp: i, category: "test", message: `msg ${i}` });
    }

    const snapshot = getSnapshot();
    expect(snapshot).toHaveLength(3);
    expect(snapshot[0].message).toBe("msg 2");
    expect(snapshot[2].message).toBe("msg 4");
  });

  it("clearBreadcrumbs empties the buffer", () => {
    addBreadcrumb({ timestamp: 1, category: "test", message: "a" });
    addBreadcrumb({ timestamp: 2, category: "test", message: "b" });
    clearBreadcrumbs();

    expect(getSnapshot()).toHaveLength(0);
  });

  it("snapshot returns a copy", () => {
    addBreadcrumb({ timestamp: 1, category: "test", message: "a" });
    const snap1 = getSnapshot();
    snap1.push({ timestamp: 99, category: "fake", message: "injected" });

    expect(getSnapshot()).toHaveLength(1);
  });

  it("drain returns items and empties buffer", () => {
    addBreadcrumb({ timestamp: 1, category: "test", message: "a" });
    addBreadcrumb({ timestamp: 2, category: "test", message: "b" });

    const drained = drainBreadcrumbs();
    expect(drained).toHaveLength(2);
    expect(drained[0].message).toBe("a");
    expect(drained[1].message).toBe("b");

    // Buffer is now empty
    expect(getSnapshot()).toHaveLength(0);
    expect(drainBreadcrumbs()).toHaveLength(0);
  });

  it("snapshot still works after drain (for error payloads)", () => {
    addBreadcrumb({ timestamp: 1, category: "test", message: "a" });
    drainBreadcrumbs();

    // New breadcrumb after drain
    addBreadcrumb({ timestamp: 2, category: "test", message: "b" });
    expect(getSnapshot()).toHaveLength(1);
    expect(getSnapshot()[0].message).toBe("b");
  });

  it("updateBreadcrumbConfig replaces the active config", () => {
    // Start with network disabled
    initBreadcrumbs(
      { ...defaultBreadcrumbConfig, network: false },
      "http://localhost/ingest/browser",
    );

    // Update to enable network (config propagation from server)
    updateBreadcrumbConfig({ ...defaultBreadcrumbConfig, network: true });

    // The config reference is updated — new network breadcrumbs would
    // use the updated blocklist/allowlist. We can't easily test fetch
    // patching here, but we verify the function doesn't throw.
  });

  describe("network breadcrumbs", () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
      originalFetch = window.fetch;
    });

    afterEach(() => {
      destroyNetworkHook();
      window.fetch = originalFetch;
    });

    it("includes the HTTP status code for non-2xx responses, not '(error)'", async () => {
      // (error) belongs to true transport failures (thrown fetch / xhr error
      // event). A 404 is a perfectly received response and should land as
      // `GET <url> 404`, like a 200 lands as `GET <url> 200` — the breadcrumb
      // timeline is more useful when status codes are visible.
      window.fetch = async () =>
        new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });

      initNetworkHook();
      initBreadcrumbs(
        { ...defaultBreadcrumbConfig, network: true },
        "http://localhost/ingest/browser",
      );

      await window.fetch("http://example.com/api/missing");
      // Allow any deferred body capture / resource timing to settle.
      await new Promise((r) => setTimeout(r, 200));

      const networkCrumb = getSnapshot().find((b) => b.category === "network");
      expect(networkCrumb).toBeDefined();
      expect(networkCrumb!.message).toBe("GET http://example.com/api/missing 404");
      expect(networkCrumb!.message).not.toContain("(error)");
      expect(networkCrumb!.data?.status).toBe(404);
      expect(networkCrumb!.data?.error).toBeUndefined();
    });

    it("does not push the breadcrumb until deferred work (body, resource_timing) has settled", async () => {
      // The fix in 4538dd3 awaits resource-timing lookup before
      // addBreadcrumb, mirroring the body-capture fix. A regression to the
      // old setTimeout-and-mutate pattern would re-open a window where a
      // flush between fetch resolution and the timing entry's arrival
      // would serialise an incomplete breadcrumb. Catch that by asserting
      // that draining immediately after the user's fetch resolves returns
      // no network crumb yet.
      window.fetch = async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });

      initNetworkHook();
      initBreadcrumbs(
        { ...defaultBreadcrumbConfig, network: true },
        "http://localhost/ingest/browser",
      );

      await window.fetch("http://example.com/api/sync");

      // recordNetworkBreadcrumb is suspended on `await response.clone().text()`
      // (and then the resource-timing await) — the breadcrumb must not be in
      // the buffer yet.
      const drainedNetwork = drainBreadcrumbs().filter(
        (b) => b.category === "network",
      );
      expect(drainedNetwork).toHaveLength(0);

      // Past the 150 ms resource-timing await, the breadcrumb lands.
      await new Promise((r) => setTimeout(r, 200));
      const eventual = getSnapshot().filter((b) => b.category === "network");
      expect(eventual).toHaveLength(1);
      expect(eventual[0].data?.status).toBe(200);
    });

    it("emits '(error)' only for true transport failures", async () => {
      window.fetch = async () => {
        throw new TypeError("Network error");
      };

      initNetworkHook();
      initBreadcrumbs(
        { ...defaultBreadcrumbConfig, network: true },
        "http://localhost/ingest/browser",
      );

      await window.fetch("http://example.com/api/down").catch(() => {});
      await new Promise((r) => setTimeout(r, 50));

      const networkCrumb = getSnapshot().find((b) => b.category === "network");
      expect(networkCrumb).toBeDefined();
      expect(networkCrumb!.message).toBe("GET http://example.com/api/down (error)");
      expect(networkCrumb!.data?.error).toBe(true);
    });
  });

  it("updateBreadcrumbConfig disabling clicks stops new click breadcrumbs", () => {
    // Per-category toggles must respond to runtime updates from the server.
    // Otherwise narrowing config (e.g. disabling clicks via remote config)
    // is silently ignored because listeners were registered at init time.
    initBreadcrumbs(
      { ...defaultBreadcrumbConfig, clicks: true },
      "http://localhost/ingest/browser",
    );

    const button = document.createElement("button");
    button.textContent = "Submit";
    document.body.appendChild(button);

    button.click();
    const before = getSnapshot().filter(b => b.category === "click").length;
    expect(before).toBeGreaterThanOrEqual(1);

    updateBreadcrumbConfig({ ...defaultBreadcrumbConfig, clicks: false });

    button.click();
    const after = getSnapshot().filter(b => b.category === "click").length;
    expect(after).toBe(before);

    document.body.removeChild(button);
  });

  describe("click breadcrumbs", () => {
    it("records click events", () => {
      initBreadcrumbs(
        { ...defaultBreadcrumbConfig, clicks: true },
        "http://localhost/ingest/browser",
      );

      const button = document.createElement("button");
      button.textContent = "Submit";
      document.body.appendChild(button);
      button.click();
      document.body.removeChild(button);

      const clicks = getSnapshot().filter((b) => b.category === "click");
      expect(clicks.length).toBeGreaterThanOrEqual(1);
      expect(clicks[0].message).toContain("button");
    });

    it("detects rage clicks synchronously", () => {
      initBreadcrumbs(
        { ...defaultBreadcrumbConfig, clicks: true },
        "http://localhost/ingest/browser",
      );

      const button = document.createElement("button");
      button.textContent = "Click me";
      document.body.appendChild(button);

      // 3 rapid clicks in close proximity — rage should fire on the third
      // click, without waiting for any timer.
      button.click();
      button.click();
      button.click();

      const rage = getSnapshot().filter((b) => b.category === "rage_click");
      expect(rage.length).toBeGreaterThanOrEqual(1);
      document.body.removeChild(button);
    });

    it("emits rage even when clicks cause a DOM mutation (regression)", () => {
      // The earlier implementation funneled rage through
      // scheduleClickDetection, which cancels when the clicked element's
      // DOM subtree mutates. Adding a breadcrumb itself mutates the DOM,
      // so rage was silently suppressed. Rage must fire regardless of
      // mutations that happen between clicks.
      initBreadcrumbs(
        { ...defaultBreadcrumbConfig, clicks: true },
        "http://localhost/ingest/browser",
      );

      const button = document.createElement("button");
      button.textContent = "Click me";
      document.body.appendChild(button);

      button.click();
      // Simulate an app reacting to the click by mutating the DOM.
      button.appendChild(document.createElement("span"));
      button.click();
      button.appendChild(document.createElement("span"));
      button.click();

      const rage = getSnapshot().filter((b) => b.category === "rage_click");
      expect(rage.length).toBeGreaterThanOrEqual(1);
      document.body.removeChild(button);
    });
  });

  describe("console breadcrumbs", () => {
    it("records console.warn", () => {
      initBreadcrumbs(
        { ...defaultBreadcrumbConfig, console: true },
        "http://localhost/ingest/browser",
      );
      console.warn("test warning");

      const consoleBreadcrumbs = getSnapshot().filter(
        (b) => b.category === "console",
      );
      expect(consoleBreadcrumbs.length).toBeGreaterThanOrEqual(1);
      expect(consoleBreadcrumbs[0].message).toContain("test warning");
      expect(consoleBreadcrumbs[0].data?.level).toBe("warn");
    });

    it("records console.error", () => {
      initBreadcrumbs(
        { ...defaultBreadcrumbConfig, console: true },
        "http://localhost/ingest/browser",
      );
      console.error("test error");

      const consoleBreadcrumbs = getSnapshot().filter(
        (b) => b.category === "console",
      );
      expect(consoleBreadcrumbs.length).toBeGreaterThanOrEqual(1);
      expect(consoleBreadcrumbs[0].data?.level).toBe("error");
    });

    it("truncates long console messages to 200 chars", () => {
      initBreadcrumbs(
        { ...defaultBreadcrumbConfig, console: true },
        "http://localhost/ingest/browser",
      );
      console.warn("x".repeat(300));

      const consoleBreadcrumbs = getSnapshot().filter(
        (b) => b.category === "console",
      );
      expect(consoleBreadcrumbs[0].message.length).toBeLessThanOrEqual(200);
    });
  });

  describe("scroll depth breadcrumbs", () => {
    it("records scroll depth on visibility hidden", () => {
      vi.useFakeTimers();
      initBreadcrumbs(
        { ...defaultBreadcrumbConfig, scroll_depth: true },
        "http://localhost/ingest/browser",
      );
      clearBreadcrumbs();

      // In jsdom, scrollHeight === innerHeight, so getScrollPercent() returns 100.
      // Fire scroll on document.body (capture phase listener on document catches it).
      // Advance past the 200ms throttle so maxScrollPercent updates.
      document.body.dispatchEvent(new Event("scroll", { bubbles: false }));
      vi.advanceTimersByTime(250);

      // Trigger flush via visibilitychange → hidden
      Object.defineProperty(document, "visibilityState", {
        value: "hidden",
        writable: true,
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));

      const scrollCrumbs = getSnapshot().filter((b) => b.category === "scroll_depth");
      expect(scrollCrumbs.length).toBeGreaterThanOrEqual(1);
      expect(scrollCrumbs[0].data?.percent).toBe(100);

      // Restore
      Object.defineProperty(document, "visibilityState", {
        value: "visible",
        writable: true,
        configurable: true,
      });
      vi.useRealTimers();
    });
  });

  describe("form abandonment breadcrumbs", () => {
    it("records form abandonment on navigation away", () => {
      initBreadcrumbs(
        { ...defaultBreadcrumbConfig, form_abandonment: true },
        "http://localhost/ingest/browser",
      );
      clearBreadcrumbs();

      const form = document.createElement("form");
      form.method = "post"; // non-GET — GET forms are treated as search/filter
      const input = document.createElement("input");
      input.type = "text";
      form.appendChild(input);
      document.body.appendChild(form);

      // A keystroke (input event) marks the form as interacted — focus alone
      // no longer counts, to filter out tab-through / click-to-paste noise.
      input.value = "hello";
      input.dispatchEvent(new Event("input", { bubbles: true }));

      // Navigate away without submitting
      window.dispatchEvent(new PopStateEvent("popstate"));

      const abandonments = getSnapshot().filter((b) => b.category === "form_abandonment");
      expect(abandonments.length).toBeGreaterThanOrEqual(1);
      expect(abandonments[0].message).toContain("form");

      document.body.removeChild(form);
    });

    it("ignores GET forms (search / filter UIs)", () => {
      initBreadcrumbs(
        { ...defaultBreadcrumbConfig, form_abandonment: true },
        "http://localhost/ingest/browser",
      );
      clearBreadcrumbs();

      const form = document.createElement("form");
      // default method is GET
      const input = document.createElement("input");
      input.type = "search";
      form.appendChild(input);
      document.body.appendChild(form);

      input.value = "query";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      window.dispatchEvent(new PopStateEvent("popstate"));

      const abandonments = getSnapshot().filter((b) => b.category === "form_abandonment");
      expect(abandonments.length).toBe(0);

      document.body.removeChild(form);
    });

    it("ignores focus without keystroke (no real interaction)", () => {
      initBreadcrumbs(
        { ...defaultBreadcrumbConfig, form_abandonment: true },
        "http://localhost/ingest/browser",
      );
      clearBreadcrumbs();

      const form = document.createElement("form");
      form.method = "post";
      const input = document.createElement("input");
      input.type = "text";
      form.appendChild(input);
      document.body.appendChild(form);

      input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      window.dispatchEvent(new PopStateEvent("popstate"));

      const abandonments = getSnapshot().filter((b) => b.category === "form_abandonment");
      expect(abandonments.length).toBe(0);

      document.body.removeChild(form);
    });

    it("does not record if form was submitted", () => {
      initBreadcrumbs(
        { ...defaultBreadcrumbConfig, form_abandonment: true },
        "http://localhost/ingest/browser",
      );
      clearBreadcrumbs();

      const form = document.createElement("form");
      form.method = "post";
      const input = document.createElement("input");
      input.type = "text";
      form.appendChild(input);
      document.body.appendChild(form);

      // Type into the input, then submit
      input.value = "hello";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      form.dispatchEvent(new SubmitEvent("submit", { bubbles: true }));

      // Navigate away
      window.dispatchEvent(new PopStateEvent("popstate"));

      const abandonments = getSnapshot().filter((b) => b.category === "form_abandonment");
      expect(abandonments).toHaveLength(0);

      document.body.removeChild(form);
    });
  });

  describe("user timing breadcrumbs", () => {
    it("records performance.mark entries", () => {
      initBreadcrumbs(
        { ...defaultBreadcrumbConfig, user_timing: true },
        "http://localhost/ingest/browser",
      );
      clearBreadcrumbs();

      performance.mark("test-mark");

      // PerformanceObserver fires asynchronously — give it a tick
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const timings = getSnapshot().filter((b) => b.category === "user_timing");
          expect(timings.length).toBeGreaterThanOrEqual(1);
          expect(timings.some((t) => t.message === "test-mark")).toBe(true);
          performance.clearMarks("test-mark");
          resolve();
        }, 50);
      });
    });

    it("records performance.measure entries with duration", () => {
      initBreadcrumbs(
        { ...defaultBreadcrumbConfig, user_timing: true },
        "http://localhost/ingest/browser",
      );
      clearBreadcrumbs();

      performance.mark("measure-start");
      performance.mark("measure-end");
      performance.measure("test-measure", "measure-start", "measure-end");

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const timings = getSnapshot().filter(
            (b) => b.category === "user_timing" && b.data?.type === "measure",
          );
          expect(timings.length).toBeGreaterThanOrEqual(1);
          expect(timings[0].message).toContain("test-measure");
          expect(timings[0].data?.duration).toBeDefined();
          performance.clearMarks();
          performance.clearMeasures();
          resolve();
        }, 50);
      });
    });
  });

  describe("visibility breadcrumbs", () => {
    it("records visibilitychange events", () => {
      initBreadcrumbs(defaultBreadcrumbConfig, "http://localhost/ingest/browser");

      document.dispatchEvent(new Event("visibilitychange"));

      const vis = getSnapshot().filter((b) => b.category === "visibility");
      expect(vis.length).toBeGreaterThanOrEqual(1);
      expect(vis[0].data?.state).toBeDefined();
    });
  });

  describe("tab lifecycle breadcrumbs", () => {
    it("emits exactly one tab_open per init", () => {
      initBreadcrumbs(defaultBreadcrumbConfig, "http://localhost/ingest/browser");

      const open = getSnapshot().filter(
        (b) => b.category === "tab" && b.data?.event === "open",
      );
      expect(open).toHaveLength(1);
      expect(open[0].message).toBe("Tab opened");
    });

    it("emits exactly one tab_close per pagehide", () => {
      initBreadcrumbs(defaultBreadcrumbConfig, "http://localhost/ingest/browser");
      clearBreadcrumbs();

      window.dispatchEvent(new Event("pagehide"));

      const close = getSnapshot().filter(
        (b) => b.category === "tab" && b.data?.event === "close",
      );
      expect(close).toHaveLength(1);
      expect(close[0].message).toBe("Tab closed");
    });
  });
});
