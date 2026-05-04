import { describe, it, expect, beforeEach } from "vitest";
import { initTracing, consumeTraceId } from "./tracing.js";

describe("tracing", () => {
  describe("consumeTraceId", () => {
    it("returns undefined when no trace was generated", () => {
      expect(consumeTraceId("http://example.com/api")).toBeUndefined();
    });
  });

  describe("glob matching via fetch patching", () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
      originalFetch = window.fetch;
    });

    it("injects traceparent header for matching URLs", async () => {
      let capturedHeaders: Headers | undefined;
      window.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response();
      };

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

      initTracing(["api.example.com/**"]);

      await window.fetch("http://other.com/api/test");

      expect(capturedHeaders?.get("traceparent")).toBeNull();
    });

    it("stores trace_id for consumption by breadcrumbs", async () => {
      window.fetch = async () => new Response();

      initTracing(["localhost/**"]);

      await window.fetch("http://localhost/api/users");

      const traceId = consumeTraceId("http://localhost/api/users");
      expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    });

    it("consumeTraceId removes the trace after first read", async () => {
      window.fetch = async () => new Response();

      initTracing(["localhost/**"]);

      await window.fetch("http://localhost/api/users");

      const first = consumeTraceId("http://localhost/api/users");
      const second = consumeTraceId("http://localhost/api/users");

      expect(first).toBeTruthy();
      expect(second).toBeUndefined();
    });
  });
});
