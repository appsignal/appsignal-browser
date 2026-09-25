import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initTracing, consumeTraceId, claimErrorTrace, destroyTracing } from "./tracing.js";
import { initNetworkHook, destroyNetworkHook } from "./network-hook.js";

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

    it("stores trace_id for consumption by breadcrumbs", async () => {
      window.fetch = async () => new Response();

      initNetworkHook();
      initTracing(["localhost/**"]);

      await window.fetch("http://localhost/api/users");

      const traceId = consumeTraceId("http://localhost/api/users");
      expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    });

    it("consumeTraceId removes the trace after first read", async () => {
      window.fetch = async () => new Response();

      initNetworkHook();
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

      initNetworkHook();
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

  describe("claimErrorTrace", () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
      originalFetch = window.fetch;
      window.fetch = async () => new Response();
    });

    afterEach(() => {
      destroyTracing();
      destroyNetworkHook();
      window.fetch = originalFetch;
      vi.useRealTimers();
    });

    it("returns nothing when no request propagated a trace", () => {
      initNetworkHook();
      initTracing(["localhost/**"]);

      expect(claimErrorTrace()).toBeUndefined();
    });

    it("takes the span the last request's traceparent promised", async () => {
      const sentHeaders: Headers[] = [];
      window.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        sentHeaders.push(new Headers(init?.headers));
        return new Response();
      };

      initNetworkHook();
      initTracing(["localhost/**"]);

      await window.fetch("http://localhost/api/one");
      await window.fetch("http://localhost/api/two");

      const [, traceFromHeader, spanFromHeader] = sentHeaders[1].get("traceparent")!.split("-");
      const claimed = claimErrorTrace()!;

      // The second request, not the first: the error follows the most recent.
      expect(claimed.trace_id).toBe(traceFromHeader);
      expect(claimed.span_id).toBe(spanFromHeader);
      expect(claimed.parent_span_id).toBeUndefined();
      expect(claimed.start_time).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    });

    it("ignores a request it does not propagate to", async () => {
      initNetworkHook();
      initTracing(["localhost/**"]);

      await window.fetch("http://other.com/api/one");

      expect(claimErrorTrace()).toBeUndefined();
    });

    it("hangs a second error off the first", async () => {
      initNetworkHook();
      initTracing(["localhost/**"]);

      await window.fetch("http://localhost/api/one");

      const first = claimErrorTrace()!;
      const second = claimErrorTrace()!;

      expect(second.trace_id).toBe(first.trace_id);
      expect(second.parent_span_id).toBe(first.span_id);
      expect(second.span_id).toBeUndefined();
      expect(second.start_time).toBeUndefined();
    });

    it("gives each error the request it followed", async () => {
      // Two requests, an error after each. The second error joins the second
      // request, because that request promised a span of its own.
      initNetworkHook();
      initTracing(["localhost/**"]);

      await window.fetch("http://localhost/api/one");
      const first = claimErrorTrace()!;

      await window.fetch("http://localhost/api/two");
      const second = claimErrorTrace()!;

      expect(second.trace_id).not.toBe(first.trace_id);
      expect(second.span_id).toBeTruthy();
      expect(second.span_id).not.toBe(first.span_id);
      expect(second.parent_span_id).toBeUndefined();
    });

    it("lets go of a request the error is too late for", async () => {
      // An error minutes after the last request has nothing to do with it, and
      // a trace that says otherwise is worse than no trace.
      vi.useFakeTimers();

      initNetworkHook();
      initTracing(["localhost/**"]);

      await window.fetch("http://localhost/api/one");
      vi.advanceTimersByTime(11_000);

      expect(claimErrorTrace()).toBeUndefined();
    });
  });
});
