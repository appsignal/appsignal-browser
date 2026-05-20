import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  initBreadcrumbs,
  addBreadcrumb,
  addManualBreadcrumb,
  getSnapshot,
  drainBreadcrumbs,
  clearBreadcrumbs,
} from "./breadcrumbs.js";
import { initNetworkHook, destroyNetworkHook } from "./network-hook.js";
import type { ResolvedConfig } from "./types.js";

vi.mock("./errors.js", () => ({
  getLastErrorTimestamp: vi.fn(() => 0),
}));

vi.mock("./tracing.js", () => ({
  consumeTraceId: vi.fn(() => undefined),
}));

const defaultBreadcrumbConfig: ResolvedConfig["breadcrumbs"] = {
  enabled: true,
  network: false,
  networkBlocklist: [],
  console: false,
  clicks: false,
  longTasks: false,
  scrollDepth: false,
  formAbandonment: false,
  userTiming: false,
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

  describe("beforeBreadcrumb", () => {
    // initBreadcrumbs itself pushes 1-2 init breadcrumbs (navigation,
    // document load); reset the hook + buffer after init so each test
    // reasons about its own additions.
    function setup(hook: (breadcrumb: Parameters<typeof addBreadcrumb>[0]) => ReturnType<typeof addBreadcrumb> | unknown): void {
      initBreadcrumbs(
        defaultBreadcrumbConfig,
        "http://localhost/ingest/browser",
        [],
        { maskText: [], blockElement: [] },
        hook as Parameters<typeof initBreadcrumbs>[4],
      );
      clearBreadcrumbs();
      (hook as unknown as { mockClear?: () => void }).mockClear?.();
    }

    it("can drop a breadcrumb by returning null", () => {
      const hook = vi.fn(() => null);
      setup(hook);

      addBreadcrumb({ timestamp: 1, category: "test", message: "drop me" });

      expect(hook).toHaveBeenCalledTimes(1);
      expect(getSnapshot()).toHaveLength(0);
    });

    it("can mutate a breadcrumb before it enters the buffer", () => {
      const hook = vi.fn((breadcrumb: Parameters<typeof addBreadcrumb>[0]) => ({
        ...breadcrumb,
        message: breadcrumb.message.replace(/secret/g, "[redacted]"),
      }));
      setup(hook);

      addBreadcrumb({ timestamp: 1, category: "test", message: "the secret is X" });

      const snap = getSnapshot();
      expect(snap).toHaveLength(1);
      expect(snap[0].message).toBe("the [redacted] is X");
    });

    it("fires on every breadcrumb regardless of category", () => {
      // The whole point of beforeBreadcrumb being at the single addBreadcrumb
      // entry point: redacting once covers errors, networks, clicks, manual
      // breadcrumbs alike. Three different categories should each hit the
      // hook.
      const hook = vi.fn((breadcrumb: Parameters<typeof addBreadcrumb>[0]) => breadcrumb);
      setup(hook);

      addBreadcrumb({ timestamp: 1, category: "error", message: "a" });
      addBreadcrumb({ timestamp: 2, category: "navigation", message: "b" });
      addManualBreadcrumb({ category: "ui", message: "c" });

      expect(hook).toHaveBeenCalledTimes(3);
    });

    it("treats a throwing callback as passthrough", () => {
      // A bug in user code shouldn't silently eat every breadcrumb. Passthrough
      // is safer than drop: the SDK keeps recording even if the host's hook
      // has a latent regression.
      const hook = vi.fn(() => {
        throw new Error("user bug");
      });
      setup(hook);

      addBreadcrumb({ timestamp: 1, category: "test", message: "survives" });

      expect(hook).toHaveBeenCalled();
      expect(getSnapshot()).toHaveLength(1);
    });
  });

  it("re-init replaces the active config", () => {
    // Start with network disabled
    initBreadcrumbs(
      { ...defaultBreadcrumbConfig, network: false },
      "http://localhost/ingest/browser",
    );

    // Re-init to enable network — config is locked at init time, so a
    // category change happens via initBreadcrumbs, not a mid-life setter.
    initBreadcrumbs(
      { ...defaultBreadcrumbConfig, network: true },
      "http://localhost/ingest/browser",
    );

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
      // no network breadcrumb yet.
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

  it("re-init disabling clicks stops new click breadcrumbs", () => {
    // Per-category toggles take effect on re-init. (Old behavior used a
    // mid-life updateBreadcrumbConfig setter; without server config there's
    // no remote-narrowing path, so a re-init is the only way to flip a
    // category. The handler still re-reads `config` at fire time, so we
    // verify the new config wins.)
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

    initBreadcrumbs(
      { ...defaultBreadcrumbConfig, clicks: false },
      "http://localhost/ingest/browser",
    );
    // initBreadcrumbs calls destroyBreadcrumbs which clears the buffer; start
    // the post-reinit count from the cleared baseline.
    expect(getSnapshot().filter(b => b.category === "click")).toHaveLength(0);

    button.click();
    const after = getSnapshot().filter(b => b.category === "click").length;
    expect(after).toBe(0);

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
      expect(typeof clicks[0].data?.x).toBe("number");
      expect(typeof clicks[0].data?.y).toBe("number");
      expect(Number.isInteger(clicks[0].data?.x)).toBe(true);
      expect(Number.isInteger(clicks[0].data?.y)).toBe(true);
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

    it("masks the click breadcrumb text when the target matches mask_text", () => {
      // privacy.dom.mask_text replaces visible text in the click breadcrumb
      // with "[masked]". The breadcrumb still fires (you can see *that* a
      // click happened on a PII element); the text content does not ride along.
      initBreadcrumbs(
        { ...defaultBreadcrumbConfig, clicks: true },
        "http://localhost/ingest/browser",
        [],
        { maskText: [".pii"], blockElement: [] },
      );

      const button = document.createElement("button");
      button.className = "pii";
      button.textContent = "Logout john@example.com";
      document.body.appendChild(button);
      button.click();
      document.body.removeChild(button);

      const clicks = getSnapshot().filter((b) => b.category === "click");
      expect(clicks).toHaveLength(1);
      expect(clicks[0].message).toContain("[masked]");
      expect(clicks[0].message).not.toContain("john@example.com");
    });

    it("masks when an ancestor matches mask_text (closest semantics)", () => {
      // The selector resolves via el.closest(), so a click on a descendant of
      // a masked container still gets its text masked — matches the rrweb
      // semantics where ancestor masking covers the whole subtree.
      initBreadcrumbs(
        { ...defaultBreadcrumbConfig, clicks: true },
        "http://localhost/ingest/browser",
        [],
        { maskText: ["[data-pii]"], blockElement: [] },
      );

      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-pii", "");
      const button = document.createElement("button");
      button.textContent = "card 4242";
      wrapper.appendChild(button);
      document.body.appendChild(wrapper);
      button.click();
      document.body.removeChild(wrapper);

      const clicks = getSnapshot().filter((b) => b.category === "click");
      expect(clicks).toHaveLength(1);
      expect(clicks[0].message).not.toContain("4242");
    });

    it("suppresses the entire click breadcrumb when target matches block_element", () => {
      // block_element is stronger than mask: no breadcrumb at all. Rage / dead /
      // error_click derivations are also skipped (they live behind the same
      // early-return in the handler).
      initBreadcrumbs(
        { ...defaultBreadcrumbConfig, clicks: true },
        "http://localhost/ingest/browser",
        [],
        { maskText: [], blockElement: [".payment-form"] },
      );

      const wrapper = document.createElement("div");
      wrapper.className = "payment-form";
      const button = document.createElement("button");
      button.textContent = "Submit payment";
      wrapper.appendChild(button);
      document.body.appendChild(wrapper);

      // Three rapid clicks would normally trigger rage_click too — both must
      // be absent under block_element.
      button.click();
      button.click();
      button.click();
      document.body.removeChild(wrapper);

      const clicks = getSnapshot().filter(
        (b) => b.category === "click" || b.category === "rage_click",
      );
      expect(clicks).toHaveLength(0);
    });

    it("re-init propagates new dom selectors to the click handler", () => {
      // Config is locked at init: switching mask selectors happens by
      // re-calling initBreadcrumbs. setPrivacyDom rebuilds the selector cache.
      initBreadcrumbs(
        { ...defaultBreadcrumbConfig, clicks: true },
        "http://localhost/ingest/browser",
        [],
        { maskText: [], blockElement: [] },
      );

      const button = document.createElement("button");
      button.className = "pii";
      button.textContent = "leak me";
      document.body.appendChild(button);
      button.click();

      const before = getSnapshot().filter((b) => b.category === "click");
      expect(before[0].message).toContain("leak me");

      initBreadcrumbs(
        { ...defaultBreadcrumbConfig, clicks: true },
        "http://localhost/ingest/browser",
        [],
        { maskText: [".pii"], blockElement: [] },
      );

      button.click();
      const after = getSnapshot().filter((b) => b.category === "click");
      // After re-init the buffer was cleared; only the masked second click remains.
      expect(after).toHaveLength(1);
      expect(after[0].message).toContain("[masked]");
      expect(after[0].message).not.toContain("leak me");

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
        { ...defaultBreadcrumbConfig, scrollDepth: true },
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
        { ...defaultBreadcrumbConfig, formAbandonment: true },
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
        { ...defaultBreadcrumbConfig, formAbandonment: true },
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
        { ...defaultBreadcrumbConfig, formAbandonment: true },
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
        { ...defaultBreadcrumbConfig, formAbandonment: true },
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
        { ...defaultBreadcrumbConfig, userTiming: true },
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
        { ...defaultBreadcrumbConfig, userTiming: true },
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
