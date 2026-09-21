import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initTracing, markTracingNavigation, getNavigation, destroyTracing } from "./tracing.js";
import { initNetworkHook, destroyNetworkHook } from "./network-hook.js";

describe("tracing", () => {
  describe("getNavigation", () => {
    it("returns undefined for a trace it never opened", () => {
      expect(getNavigation("0".repeat(32))).toBeUndefined();
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
      expect(first[1]).toMatch(/^[0-9a-f]{32}$/);
      expect(second[1]).toBe(first[1]);
      // The navigation span parents every request, so each backend span has a
      // parent that exists.
      expect(second[2]).toBe(first[2]);
      expect(second[2]).toMatch(/^[0-9a-f]{16}$/);
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
      markTracingNavigation();
      await window.fetch("http://localhost/api/two");

      const [first, second] = sent.map((header) => header.split("-"));
      expect(second[1]).not.toBe(first[1]);
    });

    it("names the navigation a trace belongs to", async () => {
      const sent: string[] = [];
      window.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        sent.push(new Headers(init?.headers).get("traceparent") ?? "");
        return new Response();
      };

      initNetworkHook();
      initTracing(["localhost/**"], () => "/checkout");

      await window.fetch("http://localhost/api/cart");

      const [, traceId, spanId] = sent[0].split("-");
      const navigation = getNavigation(traceId);
      expect(navigation?.action).toBe("/checkout");
      expect(navigation?.span_id).toBe(spanId);
    });
  });
});
