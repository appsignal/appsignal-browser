import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  initBreadcrumbs,
  destroyBreadcrumbs,
  onAfterNavigation,
  addBreadcrumb,
  addManualBreadcrumb,
  getSnapshot,
  getErrorBreadcrumbs,
  drainBreadcrumbs,
  clearBreadcrumbs,
} from "./breadcrumbs.js";
import { initNetworkHook, destroyNetworkHook } from "./network-hook.js";
import { timeOrigin } from "./utils.js";
import type { ResolvedConfig } from "./types.js";

vi.mock("./errors.js", () => ({
  getLastErrorTimestamp: vi.fn(() => 0),
}));

vi.mock("./tracing.js", () => ({
  traceIdForUrl: vi.fn(() => undefined),
}));

const defaultBreadcrumbConfig: ResolvedConfig["breadcrumbs"] = {
  network: false,
  console: false,
  clicks: false,
  longTasks: false,
  scrollDepth: false,
};

describe("breadcrumbs", () => {
  beforeEach(() => {
    initBreadcrumbs(defaultBreadcrumbConfig, ["http://localhost/ingest/browser"]);
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

  it("session buffer caps at 100 — oldest entries evicted past that", () => {
    for (let i = 0; i < 105; i++) {
      addBreadcrumb({ timestamp: i, category: "test", message: `msg ${i}` });
    }

    const snapshot = getSnapshot();
    expect(snapshot).toHaveLength(100);
    // FIFO eviction: first 5 dropped, snapshot starts at msg 5.
    expect(snapshot[0].message).toBe("msg 5");
    expect(snapshot[99].message).toBe("msg 104");
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

    // Session buffer is now empty
    expect(getSnapshot()).toHaveLength(0);
    expect(drainBreadcrumbs()).toHaveLength(0);
  });

  describe("error-context buffer", () => {
    it("admits only allowlisted SDK categories", () => {
      // Allowlist means new SDK-emitted categories default to session-only.
      // To opt a category in for errors it has to be added to
      // ERROR_BUFFER_CATEGORIES explicitly — a safer default than denylist.
      const allowed = [
        "navigation", "click", "network",
        "console", "error", "long_task", "visibility",
      ];
      for (const category of allowed) {
        addBreadcrumb({ timestamp: 1, category, message: `${category} crumb` });
      }
      expect(getErrorBreadcrumbs()).toHaveLength(allowed.length);
    });

    it("rejects un-allowlisted SDK categories (rage_click, dead_click, scroll_depth, …)", () => {
      // These stay in the session stream — UX signals belong in the journey
      // view, just not in the error payload.
      const noise = ["rage_click", "dead_click", "error_click", "scroll_depth", "tab"];
      for (const category of noise) {
        addBreadcrumb({ timestamp: 1, category, message: `${category} noise` });
      }
      expect(getSnapshot()).toHaveLength(noise.length);
      expect(getErrorBreadcrumbs()).toHaveLength(0);
    });

    it("addManualBreadcrumb bypasses the allowlist — any host category lands in errors", () => {
      // Hosts call addBreadcrumb() intentionally for debugging; forcing
      // them to use one of the SDK's reserved categories would be a
      // hostile API. Manual breadcrumbs always land in both buffers.
      addManualBreadcrumb({ category: "checkout-step", message: "entered payment" });
      addManualBreadcrumb({ category: "feature-flag", message: "v2 ui enabled" });

      const errCrumbs = getErrorBreadcrumbs();
      expect(errCrumbs).toHaveLength(2);
      expect(errCrumbs.map((c) => c.category)).toEqual(["checkout-step", "feature-flag"]);
      // Also in session buffer.
      expect(getSnapshot()).toHaveLength(2);
    });

    it("caps at 25 — oldest debug-relevant entries evicted past that", () => {
      // Interleave useful + UX-noise pushes to confirm that the cap is on
      // useful entries specifically: 40 clicks land, the noise doesn't
      // consume budget, and the error buffer keeps the most recent 25.
      for (let i = 0; i < 40; i++) {
        addBreadcrumb({ timestamp: i, category: "click", message: `click #${i}` });
        addBreadcrumb({ timestamp: i, category: "rage_click", message: `rage #${i}` });
      }

      const errCrumbs = getErrorBreadcrumbs();
      expect(errCrumbs).toHaveLength(25);
      expect(errCrumbs[0].message).toBe("click #15");
      expect(errCrumbs[24].message).toBe("click #39");
      // None of the rage_click noise leaked through.
      expect(errCrumbs.every((c) => c.category === "click")).toBe(true);
    });

    it("survives an events flush — error buffer keeps context drainBreadcrumbs cleared from session", () => {
      // Important when an error fires shortly after the periodic 30 s flush:
      // the session buffer is empty, but the error buffer must still carry
      // context from before the flush.
      addBreadcrumb({ timestamp: 1, category: "click", message: "before flush" });
      drainBreadcrumbs();

      expect(getSnapshot()).toHaveLength(0);
      expect(getErrorBreadcrumbs()).toHaveLength(1);
      expect(getErrorBreadcrumbs()[0].message).toBe("before flush");
    });
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
        ["http://localhost/ingest/browser"],
        [],
        [],
        { maskText: [], blockElement: [] },
        hook as Parameters<typeof initBreadcrumbs>[5],
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
      ["http://localhost/ingest/browser"],
    );

    // Re-init to enable network — config is locked at init time, so a
    // category change happens via initBreadcrumbs, not a mid-life setter.
    initBreadcrumbs(
      { ...defaultBreadcrumbConfig, network: true },
      ["http://localhost/ingest/browser"],
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
        ["http://localhost/ingest/browser"],
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
        ["http://localhost/ingest/browser"],
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
        ["http://localhost/ingest/browser"],
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
      ["http://localhost/ingest/browser"],
    );

    const button = document.createElement("button");
    button.textContent = "Submit";
    document.body.appendChild(button);

    button.click();
    const before = getSnapshot().filter(b => b.category === "click").length;
    expect(before).toBeGreaterThanOrEqual(1);

    initBreadcrumbs(
      { ...defaultBreadcrumbConfig, clicks: false },
      ["http://localhost/ingest/browser"],
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
        ["http://localhost/ingest/browser"],
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
        ["http://localhost/ingest/browser"],
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
        ["http://localhost/ingest/browser"],
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
        ["http://localhost/ingest/browser"],
        [],
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
        ["http://localhost/ingest/browser"],
        [],
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
        ["http://localhost/ingest/browser"],
        [],
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
        ["http://localhost/ingest/browser"],
        [],
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
        ["http://localhost/ingest/browser"],
        [],
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
        ["http://localhost/ingest/browser"],
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
        ["http://localhost/ingest/browser"],
      );
      console.error("test error");

      const consoleBreadcrumbs = getSnapshot().filter(
        (b) => b.category === "console",
      );
      expect(consoleBreadcrumbs.length).toBeGreaterThanOrEqual(1);
      expect(consoleBreadcrumbs[0].data?.level).toBe("error");
    });

    it("surfaces an Error's message instead of serialising it to {}", () => {
      initBreadcrumbs(
        { ...defaultBreadcrumbConfig, console: true },
        ["http://localhost/ingest/browser"],
      );
      console.error(new TypeError("boom"));

      const consoleBreadcrumbs = getSnapshot().filter(
        (b) => b.category === "console",
      );
      expect(consoleBreadcrumbs[0].message).toBe("TypeError: boom");
    });

    it("surfaces the message of an error from another realm", () => {
      initBreadcrumbs(
        { ...defaultBreadcrumbConfig, console: true },
        ["http://localhost/ingest/browser"],
      );

      // An iframe/worker error carries that realm's Error constructor, so
      // `instanceof Error` is false. Non-enumerable fields, as on a real Error,
      // are what make JSON.stringify collapse it to "{}".
      const foreign = Object.create(null, {
        name: { value: "TypeError" },
        message: { value: "from another realm" },
        stack: { value: "TypeError: from another realm\n    at <anonymous>" },
      }) as object;
      expect(foreign instanceof Error).toBe(false);
      expect(JSON.stringify(foreign)).toBe("{}");

      console.error(foreign);

      const consoleBreadcrumbs = getSnapshot().filter(
        (b) => b.category === "console",
      );
      expect(consoleBreadcrumbs[0].message).toBe("TypeError: from another realm");
    });

    it("keeps rendering a plain object with name and message as JSON", () => {
      initBreadcrumbs(
        { ...defaultBreadcrumbConfig, console: true },
        ["http://localhost/ingest/browser"],
      );

      // No `stack`, so this is application data, not an error — it must not be
      // flattened to "name: message".
      console.error({ name: "checkout", message: "cart updated" });

      const consoleBreadcrumbs = getSnapshot().filter(
        (b) => b.category === "console",
      );
      expect(consoleBreadcrumbs[0].message).toBe(
        '{"name":"checkout","message":"cart updated"}',
      );
    });

    it("truncates long console messages to 200 chars", () => {
      initBreadcrumbs(
        { ...defaultBreadcrumbConfig, console: true },
        ["http://localhost/ingest/browser"],
      );
      console.warn("x".repeat(300));

      const consoleBreadcrumbs = getSnapshot().filter(
        (b) => b.category === "console",
      );
      expect(consoleBreadcrumbs[0].message.length).toBeLessThanOrEqual(200);
    });

    it("does not throw into host code on a circular argument", () => {
      // JSON.stringify throws on circular structures (DOM nodes, React
      // elements, anything with a back-reference). The patched console.error
      // must never let that escape into the host's console.error call — and
      // should still capture a degraded breadcrumb rather than drop it.
      initBreadcrumbs(
        { ...defaultBreadcrumbConfig, console: true },
        ["http://localhost/ingest/browser"],
      );
      const circular: Record<string, unknown> = {};
      circular.self = circular;

      expect(() => console.error("boom", circular)).not.toThrow();

      const consoleBreadcrumbs = getSnapshot().filter(
        (b) => b.category === "console",
      );
      expect(consoleBreadcrumbs.length).toBeGreaterThanOrEqual(1);
      // The string arg survives via the String() fallback for the circular one.
      expect(consoleBreadcrumbs[0].message).toContain("boom");
    });
  });

  describe("scroll depth breadcrumbs", () => {
    it("records scroll depth on visibility hidden", () => {
      vi.useFakeTimers();
      initBreadcrumbs(
        { ...defaultBreadcrumbConfig, scrollDepth: true },
        ["http://localhost/ingest/browser"],
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

  describe("visibility breadcrumbs", () => {
    it("records visibilitychange events", () => {
      initBreadcrumbs(defaultBreadcrumbConfig, ["http://localhost/ingest/browser"]);

      document.dispatchEvent(new Event("visibilitychange"));

      const vis = getSnapshot().filter((b) => b.category === "visibility");
      expect(vis.length).toBeGreaterThanOrEqual(1);
      expect(vis[0].data?.state).toBeDefined();
    });
  });

  describe("tab lifecycle breadcrumbs", () => {
    it("emits exactly one tab_open per init", () => {
      initBreadcrumbs(defaultBreadcrumbConfig, ["http://localhost/ingest/browser"]);

      const open = getSnapshot().filter(
        (b) => b.category === "tab" && b.data?.event === "open",
      );
      expect(open).toHaveLength(1);
      expect(open[0].message).toBe("Tab opened");
    });

    it("emits exactly one tab_close per pagehide", () => {
      initBreadcrumbs(defaultBreadcrumbConfig, ["http://localhost/ingest/browser"]);
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

describe("navigation hook composition", () => {
  let native: History["pushState"];
  let originalHref: string;

  beforeEach(() => {
    // Earlier suites leave our patch installed (module state outlives their
    // describe), so tear it down here to get back to the native method.
    destroyBreadcrumbs();
    native = history.pushState;
    originalHref = location.href;
  });

  afterEach(() => {
    destroyBreadcrumbs();
    history.pushState = native;
    native.call(history, {}, "", originalHref);
  });

  it("composes with a pre-existing history.pushState patch instead of orphaning it", () => {
    // Foreign patch (stands in for a router) installed before the SDK.
    let foreignCalls = 0;
    const foreign = function (this: History, ...args: Parameters<History["pushState"]>): void {
      foreignCalls++;
      native.apply(this, args);
    } as History["pushState"];
    history.pushState = foreign;

    initBreadcrumbs(defaultBreadcrumbConfig, ["http://localhost/ingest/browser"]);
    let sdkFired = 0;
    onAfterNavigation(() => { sdkFired++; });

    history.pushState({}, "", "/composed");

    // Both ran — foreign patch composed, not bypassed.
    expect(foreignCalls).toBe(1);
    expect(sdkFired).toBe(1);

    // Teardown restores the foreign patch, not native.
    destroyBreadcrumbs();
    expect(history.pushState).toBe(foreign);
    foreignCalls = 0;
    history.pushState({}, "", "/after-destroy");
    expect(foreignCalls).toBe(1);
  });

  it("fires listeners once per navigation when reinit has to delegate through a foreign patch", () => {
    initBreadcrumbs(defaultBreadcrumbConfig, ["http://localhost/ingest/browser"]);

    // A router patches over our wrapper *after* the SDK installed (script order
    // we don't control). Reinit can't unwrap this one — it isn't ours — so it
    // must delegate through it, leaving our first wrapper in the chain.
    let routerCalls = 0;
    const ourFirstWrapper = history.pushState;
    const router = function (this: History, ...args: Parameters<History["pushState"]>): void {
      routerCalls++;
      ourFirstWrapper.apply(this, args);
    } as History["pushState"];
    history.pushState = router;

    // Reinit (init() called twice, or HMR). Clears listeners, so re-register.
    initBreadcrumbs(defaultBreadcrumbConfig, ["http://localhost/ingest/browser"]);
    let sdkFired = 0;
    onAfterNavigation(() => { sdkFired++; });

    history.pushState({}, "", "/reinit-through-foreign");

    // The stale wrapper is still in the chain and still passes the call through,
    // but only the current generation dispatches — one breadcrumb, not two.
    expect(routerCalls).toBe(1);
    expect(sdkFired).toBe(1);
  });
});

describe("network resource timing correlation", () => {
  type PoCallback = (list: { getEntries: () => PerformanceResourceTiming[] }) => void;
  let observers: { cb: PoCallback; args?: unknown }[];

  // A resource entry for the shared URL. Phase fields are offsets from the
  // entry's own startTime so ttfb comes out as `ttfb`; startTime itself is
  // lifted from timeOrigin to "now" so it lands inside the request window.
  // Uses the production helper, so entries stay valid in the test below that
  // removes performance.timeOrigin.
  const makeResourceEntry = (ttfb: number): PerformanceResourceTiming => {
    const startTime = Date.now() - timeOrigin();
    const requestStart = startTime + 3;
    const responseStart = requestStart + ttfb;
    return {
      name: "http://example.com/api/timeseries",
      initiatorType: "fetch",
      startTime,
      domainLookupStart: startTime,
      domainLookupEnd: startTime + 1,
      connectStart: startTime + 1,
      connectEnd: startTime + 3,
      secureConnectionStart: 0,
      requestStart,
      responseStart,
      responseEnd: responseStart + 5,
      transferSize: 1200,
      encodedBodySize: 900,
      decodedBodySize: 3000,
      nextHopProtocol: "h2",
    } as unknown as PerformanceResourceTiming;
  };

  const resourceObserver = () =>
    observers.find((o) => (o.args as { type?: string })?.type === "resource");

  beforeEach(() => {
    observers = [];
    class FakePerformanceObserver {
      cb: PoCallback;
      args?: unknown;
      constructor(cb: PoCallback) {
        this.cb = cb;
        observers.push(this);
      }
      observe(args: unknown) {
        this.args = args;
      }
      disconnect() {}
    }
    vi.stubGlobal("PerformanceObserver", FakePerformanceObserver);
  });

  afterEach(() => {
    destroyBreadcrumbs();
    destroyNetworkHook();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("observes resource timing with buffered:true to capture pre-init entries", () => {
    initBreadcrumbs(
      { ...defaultBreadcrumbConfig, network: true },
      ["http://localhost/ingest/browser"],
    );

    // Without buffered:true, entries recorded before observe() are never
    // delivered, so the earliest requests on the page get no resource_timing.
    expect(resourceObserver()?.args).toEqual({ type: "resource", buffered: true });
  });

  it("matches concurrent same-URL requests to distinct resource entries", async () => {
    window.fetch = async () =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

    initNetworkHook();
    initBreadcrumbs(
      { ...defaultBreadcrumbConfig, network: true },
      ["http://localhost/ingest/browser"],
    );

    const url = "http://example.com/api/timeseries";
    await Promise.all([
      window.fetch(url, { method: "POST" }),
      window.fetch(url, { method: "POST" }),
    ]);

    // Deliver two timing entries for the same URL, as the PerformanceObserver
    // would. A URL-keyed map would collapse these to one (delete-on-read), so
    // only one breadcrumb would get timing; the list keeps both.
    resourceObserver()!.cb({ getEntries: () => [makeResourceEntry(20), makeResourceEntry(40)] });

    // Past the 150ms resource-timing retry in recordNetworkBreadcrumb.
    await new Promise((r) => setTimeout(r, 250));

    const network = getSnapshot().filter((b) => b.category === "network");
    expect(network).toHaveLength(2);
    const ttfbs = network
      .map((b) => (b.data?.resource_timing as { ttfb?: number } | undefined)?.ttfb)
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(ttfbs).toEqual([20, 40]);
  });

  it("still correlates timing when performance.timeOrigin is unavailable", async () => {
    // Chrome <62 / Safari <15 — the browser tail uuidv4's getRandomValues path
    // exists for. Undefined here used to make every window comparison NaN, so
    // no entry ever matched and resource_timing silently disappeared.
    vi.spyOn(performance, "timeOrigin", "get").mockReturnValue(
      undefined as unknown as number,
    );

    window.fetch = async () =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

    initNetworkHook();
    initBreadcrumbs(
      { ...defaultBreadcrumbConfig, network: true },
      ["http://localhost/ingest/browser"],
    );

    await window.fetch("http://example.com/api/timeseries", { method: "POST" });
    resourceObserver()!.cb({ getEntries: () => [makeResourceEntry(20)] });
    await new Promise((r) => setTimeout(r, 250));

    const network = getSnapshot().filter((b) => b.category === "network");
    expect(network).toHaveLength(1);
    expect((network[0].data?.resource_timing as { ttfb?: number })?.ttfb).toBe(20);
  });
});
