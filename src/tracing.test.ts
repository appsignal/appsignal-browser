import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initTracing, traceIdForRequest, destroyTracing } from "./tracing.js";
import { initNetworkHook, destroyNetworkHook, onAfterRequest } from "./network-hook.js";

describe("tracing", () => {
  describe("traceIdForRequest", () => {
    it("returns undefined for a request that propagated nothing", () => {
      expect(
        traceIdForRequest({ url: "http://example.com/api", method: "GET", startTime: 0, endTime: 0, error: false }),
      ).toBeUndefined();
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

    it("reports the trace id a request propagated, for its breadcrumb", async () => {
      let sent: string | undefined;
      window.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        sent = new Headers(init?.headers).get("traceparent")?.split("-")[1];
        return new Response();
      };

      initNetworkHook();
      initTracing(["localhost/**"]);
      let reported: string | undefined;
      onAfterRequest((result) => {
        reported = traceIdForRequest(result);
      });

      await window.fetch("http://localhost/api/users");

      expect(reported).toMatch(/^[0-9a-f]{32}$/);
      expect(reported).toBe(sent);
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

      const reported: (string | undefined)[] = [];
      onAfterRequest((result) => {
        reported.push(traceIdForRequest(result));
      });

      const url = "http://localhost/api/poll";
      await Promise.all([window.fetch(url), window.fetch(url)]);

      const sent1 = sentHeaders[0].get("traceparent")?.split("-")[1];
      const sent2 = sentHeaders[1].get("traceparent")?.split("-")[1];
      expect(sent1).toBeTruthy();
      expect(sent2).toBeTruthy();
      expect(sent1).not.toBe(sent2);

      expect([...reported].sort()).toEqual([sent1, sent2].sort());
    });
  });
});
