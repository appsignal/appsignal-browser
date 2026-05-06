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

    it("keeps trace IDs distinct for parallel same-URL requests", async () => {
      // Real-world example: a polling component fires two GETs to the same
      // URL while the first is still in flight. With a URL-keyed Map the
      // second recordTrace clobbers the first, so the breadcrumb that
      // consumes the ID gets attributed to the wrong request — or worse,
      // the second consumer reads `undefined`.
      const sentHeaders: Headers[] = [];
      window.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        sentHeaders.push(new Headers(init?.headers));
        return new Response();
      };

      initTracing(["localhost/**"]);

      const url = "http://localhost/api/poll";
      await Promise.all([window.fetch(url), window.fetch(url)]);

      const sent1 = sentHeaders[0].get("traceparent")?.split("-")[1];
      const sent2 = sentHeaders[1].get("traceparent")?.split("-")[1];
      expect(sent1).toBeTruthy();
      expect(sent2).toBeTruthy();
      expect(sent1).not.toBe(sent2);

      const consumed1 = consumeTraceId(url);
      const consumed2 = consumeTraceId(url);

      expect(consumed1).toBeTruthy();
      expect(consumed2).toBeTruthy();
      expect([sent1, sent2].sort()).toEqual([consumed1, consumed2].sort());
    });
  });
});
