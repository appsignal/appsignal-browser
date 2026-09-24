import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initTracing, recordException, takeTraceRoot, markTracingNavigation, destroyTracing } from "./tracing.js";
import { initNetworkHook, destroyNetworkHook } from "./network-hook.js";

describe("tracing", () => {
  describe("takeTraceRoot", () => {
    it("has nothing to send when the page propagated nothing", () => {
      expect(takeTraceRoot()).toBeUndefined();
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

      const first = takeTraceRoot();
      const second = takeTraceRoot();

      expect(first?.span_id).toMatch(/^[0-9a-f]{16}$/);
      // Declaring it twice would give one span two end times.
      expect(second).toBeUndefined();
    });

    it("carries every error of the navigation as one span's events", async () => {
      window.fetch = async () => new Response();
      initNetworkHook();
      initTracing(["localhost/**"]);
      await window.fetch("http://localhost/api/cart");

      recordException({ name: "TypeError", message: "first", timestamp: 1000 });
      recordException({ name: "RangeError", message: "second", timestamp: 1100 });

      expect(takeTraceRoot()?.exceptions.map((e) => e.message)).toEqual(["first", "second"]);
    });

    it("drops an error when the page propagated nothing, so none is claimed", () => {
      initNetworkHook();
      initTracing(["localhost/**"]);

      recordException({ name: "TypeError", message: "orphan", timestamp: 1000 });

      expect(takeTraceRoot()).toBeUndefined();
    });

    it("sends nothing for a navigation that went well", async () => {
      window.fetch = async () => new Response();
      initNetworkHook();
      initTracing(["localhost/**"]);

      await window.fetch("http://localhost/api/cart");

      // The backend already described every request it served. A span with no
      // error on it adds a page name and nothing else.
      expect(takeTraceRoot()).toBeUndefined();
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
      takeTraceRoot();
      markTracingNavigation();
      await window.fetch("http://localhost/api/two");
      recordException({ name: "TypeError", message: "again", timestamp: 2000 });

      const [first, second] = sent.map((header) => header.split("-"));
      expect(second[1]).not.toBe(first[1]);
      // The next navigation is its own span, and can be exported in its turn.
      expect(takeTraceRoot()?.trace_id).toBe(second[1]);
    });

    it("names the navigation by the route the host declared", async () => {
      window.fetch = async () => new Response();
      initNetworkHook();
      initTracing(["localhost/**"], () => "/checkout");

      await window.fetch("http://localhost/api/cart");
      recordException({ name: "TypeError", message: "boom", timestamp: 1000 });

      expect(takeTraceRoot()?.action).toBe("/checkout");
    });
  });
});
