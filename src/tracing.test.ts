import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initTracing, recordException, endNavigation, markTracingNavigation, destroyTracing } from "./tracing.js";
import { initNetworkHook, destroyNetworkHook } from "./network-hook.js";

describe("tracing", () => {
  describe("endNavigation", () => {
    it("has nothing to send when the page propagated nothing", () => {
      expect(endNavigation()).toBeUndefined();
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


    it("shares one trace and one span across every request of a page", async () => {
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
      // The navigation span parents every request, so each backend span has a
      // parent that exists.
      expect(second[2]).toBe(first[2]);
    });

    it("exports the span once, however many times the page flushes", async () => {
      window.fetch = async () => new Response();
      initNetworkHook();
      initTracing(["localhost/**"]);
      await window.fetch("http://localhost/api/cart");

      const first = endNavigation();
      const second = endNavigation();

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

      const navigation = endNavigation();
      expect(navigation?.exceptions.map((e) => e.message)).toEqual(["first", "second"]);
    });

    it("drops an error when the page propagated nothing, so none is claimed", () => {
      initNetworkHook();
      initTracing(["localhost/**"]);

      recordException({ name: "TypeError", message: "orphan", timestamp: 1000 });

      expect(endNavigation()).toBeUndefined();
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
      endNavigation();
      markTracingNavigation();
      await window.fetch("http://localhost/api/two");

      const [first, second] = sent.map((header) => header.split("-"));
      expect(second[1]).not.toBe(first[1]);
      // The next navigation is its own span, and can be exported in its turn.
      expect(endNavigation()?.trace_id).toBe(second[1]);
    });

    it("names the navigation by the route the host declared", async () => {
      window.fetch = async () => new Response();
      initNetworkHook();
      initTracing(["localhost/**"], () => "/checkout");

      await window.fetch("http://localhost/api/cart");

      expect(endNavigation()?.action).toBe("/checkout");
    });
  });
});
