import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initTracing, recordException, takeTraceRoots, markTracingNavigation, destroyTracing, getTraceContext } from "./tracing.js";
import { initNetworkHook, destroyNetworkHook } from "./network-hook.js";

describe("tracing", () => {
  describe("takeTraceRoots", () => {
    it("has nothing to send when the page propagated nothing", () => {
      expect(takeTraceRoots()).toEqual([]);
    });
  });

  describe("glob matching via fetch patching", () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
      originalFetch = window.fetch;
    });

    afterEach(() => {
      destroyTracing();
      destroyNetworkHook();
      window.fetch = originalFetch;
    });

    it("injects traceparent header for matching URLs", async () => {
      let capturedHeaders: Headers | undefined;
      window.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response();
      };

      initNetworkHook();
      initTracing(["localhost/**"]);

      // The init patches fetch, so we need to call the patched version
      await window.fetch("http://localhost/api/test");

      expect(capturedHeaders?.get("traceparent")).toMatch(
        /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
      );
    });

    it("does not inject headers for non-matching URLs", async () => {
      let capturedHeaders: Headers | undefined;
      window.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response();
      };

      initNetworkHook();
      initTracing(["api.example.com/**"]);

      await window.fetch("http://other.com/api/test");

      expect(capturedHeaders?.get("traceparent")).toBeNull();
    });


    it("gives each request its own span, under one trace", async () => {
      const sent: string[] = [];
      window.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        sent.push(new Headers(init?.headers).get("traceparent") ?? "");
        return new Response();
      };

      initNetworkHook();
      initTracing(["localhost/**"]);

      await window.fetch("http://localhost/api/cart");
      await window.fetch("http://localhost/api/prices");

      const [first, second] = sent.map((header) => header.split("-"));
      expect(second[1]).toBe(first[1]);
      // Its own CLIENT span each, so the backend spans nest under the request
      // that asked for them rather than beside every other request.
      expect(second[2]).not.toBe(first[2]);
      expect(second[2]).toMatch(/^[0-9a-f]{16}$/);
    });

    it("exports the span once, however many times the page flushes", async () => {
      window.fetch = async () => new Response();
      initNetworkHook();
      initTracing(["localhost/**"]);
      await window.fetch("http://localhost/api/cart");
      recordException({ name: "TypeError", message: "boom", timestamp: 1000 });

      const first = takeTraceRoots();
      const second = takeTraceRoots();

      expect(first[0].span_id).toMatch(/^[0-9a-f]{16}$/);
      // Declaring it twice would give one span two end times.
      expect(second).toEqual([]);
    });

    it("carries every error of the navigation as one span's events", async () => {
      window.fetch = async () => new Response();
      initNetworkHook();
      initTracing(["localhost/**"]);
      await window.fetch("http://localhost/api/cart");

      recordException({ name: "TypeError", message: "first", timestamp: 1000 });
      recordException({ name: "RangeError", message: "second", timestamp: 1100 });

      const [root] = takeTraceRoots();
      expect(root.exceptions.map((e) => e.message)).toEqual(["first", "second"]);
    });

    it("drops an error when the page propagated nothing, so none is claimed", () => {
      initNetworkHook();
      initTracing(["localhost/**"]);

      recordException({ name: "TypeError", message: "orphan", timestamp: 1000 });

      expect(takeTraceRoots()).toEqual([]);
    });

    it("sends nothing for a navigation that went well", async () => {
      window.fetch = async () => new Response();
      initNetworkHook();
      initTracing(["localhost/**"]);

      await window.fetch("http://localhost/api/cart");

      // The backend already described every request it served. A span with no
      // error on it adds a page name and nothing else.
      expect(takeTraceRoots()).toEqual([]);
    });

    it("starts a new trace on a route change", async () => {
      const sent: string[] = [];
      window.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        sent.push(new Headers(init?.headers).get("traceparent") ?? "");
        return new Response();
      };

      initNetworkHook();
      initTracing(["localhost/**"]);

      await window.fetch("http://localhost/api/one");
      recordException({ name: "TypeError", message: "boom", timestamp: 1000 });
      takeTraceRoots();
      markTracingNavigation();
      await window.fetch("http://localhost/api/two");
      recordException({ name: "TypeError", message: "again", timestamp: 2000 });

      const [first, second] = sent.map((header) => header.split("-"));
      expect(second[1]).not.toBe(first[1]);
      // The next navigation is its own span, and can be exported in its turn.
      expect(takeTraceRoots()[0].trace_id).toBe(second[1]);
    });

    it("starts a trace of its own once the person does something", async () => {
      const sent: string[] = [];
      window.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        sent.push(new Headers(init?.headers).get("traceparent") ?? "");
        return new Response();
      };

      initNetworkHook();
      initTracing(["localhost/**"]);

      // The page loading itself.
      await window.fetch("http://localhost/api/boot");
      await window.fetch("http://localhost/api/config");

      document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      await window.fetch("http://localhost/api/prices");

      const [boot, config, afterClick] = sent.map((header) => header.split("-"));
      expect(config[1]).toBe(boot[1]);
      // What the page did on its own is not in the trace the error belongs to.
      expect(afterClick[1]).not.toBe(boot[1]);
    });

    it("keeps the errors of a trace an interaction closed", async () => {
      window.fetch = async () => new Response();
      initNetworkHook();
      initTracing(["localhost/**"]);

      await window.fetch("http://localhost/api/boot");
      recordException({ name: "TypeError", message: "on load", timestamp: 1000 });

      document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      await window.fetch("http://localhost/api/prices");
      recordException({ name: "RangeError", message: "on click", timestamp: 2000 });

      const roots = takeTraceRoots();
      // Two traces, each with its own error. Rotating must not drop the first.
      expect(roots.map((root) => root.exceptions[0].message)).toEqual(["on load", "on click"]);
      expect(roots[0].trace_id).not.toBe(roots[1].trace_id);
    });

    it("holds a bounded number of traces when nothing flushes", async () => {
      window.fetch = async () => new Response();
      initNetworkHook();
      initTracing(["localhost/**"]);

      for (let i = 0; i < 30; i++) {
        document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
        await window.fetch("http://localhost/api/prices");
        recordException({ name: "TypeError", message: `boom ${i}`, timestamp: 1000 + i });
      }

      const roots = takeTraceRoots();

      // A page that errors on every interaction must not grow without limit.
      expect(roots.length).toBeLessThanOrEqual(26);
      // The newest is the one somebody is looking at when the page breaks.
      expect(roots[roots.length - 1].exceptions[0].message).toBe("boom 29");
    });

    it("does not start a trace for a gesture that asks for nothing", async () => {
      const sent: string[] = [];
      window.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        sent.push(new Headers(init?.headers).get("traceparent") ?? "");
        return new Response();
      };

      initNetworkHook();
      initTracing(["localhost/**"]);

      await window.fetch("http://localhost/api/boot");
      document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      await window.fetch("http://localhost/api/prices");

      // Three gestures, one request: scrolling and typing must not burn a trace
      // each, or a page would file traces nobody asked about.
      const [boot, afterClicks] = sent.map((header) => header.split("-"));
      expect(afterClicks[1]).not.toBe(boot[1]);
      expect(sent).toHaveLength(2);
    });

    it("names the navigation by the route the host declared", async () => {
      window.fetch = async () => new Response();
      initNetworkHook();
      initTracing(["localhost/**"], () => "/checkout");

      await window.fetch("http://localhost/api/cart");
      recordException({ name: "TypeError", message: "boom", timestamp: 1000 });

      expect(takeTraceRoots()[0].action).toBe("/checkout");
    });
  });
});
