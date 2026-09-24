import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  initTracing,
  getTraceContext,
  traceIdForUrl,
  markTracingNavigation,
  destroyTracing,
} from "./tracing.js";
import { initNetworkHook, destroyNetworkHook } from "./network-hook.js";
import type { PageLoadPayload } from "./types.js";

// The page load post rides the transport, and its action comes from the route
// state. Mock both so this file is about trace identity only.
const { pageLoads } = vi.hoisted(() => ({ pageLoads: [] as PageLoadPayload[] }));
vi.mock("./transport.js", () => ({
  sendPageLoad: (payload: PageLoadPayload) => {
    pageLoads.push(payload);
  },
}));

const routeMock = vi.hoisted(() => ({ action: "/orders" }));
vi.mock("./vitals.js", () => ({
  getRouteAction: () => routeMock.action,
}));

// The host's error tags, from setTags — mocked for the same reason as the
// route action above: this file is about trace identity, not session state.
const tagsMock = vi.hoisted(() => ({ tags: {} as Record<string, string> }));
vi.mock("./session.js", () => ({
  getTags: () => tagsMock.tags,
}));

describe("tracing", () => {
  describe("getTraceContext", () => {
    it("returns nothing when tracing was never initialised", () => {
      expect(getTraceContext()).toBeUndefined();
    });
  });

  describe("glob matching via fetch patching", () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
      originalFetch = window.fetch;
      pageLoads.length = 0;
      routeMock.action = "/orders";
      tagsMock.tags = {};
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

    it("reuses one trace_id and span_id for every propagated request", async () => {
      // One identity per navigation, so every backend request from this page
      // load is a child of the same browser span in the same trace. This is
      // what makes the propagated span ID refer to something that exists.
      const sentHeaders: Headers[] = [];
      window.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        sentHeaders.push(new Headers(init?.headers));
        return new Response();
      };

      initNetworkHook();
      initTracing(["localhost/**"]);

      await window.fetch("http://localhost/api/one");
      await window.fetch("http://localhost/api/two");

      const first = sentHeaders[0].get("traceparent");
      expect(first).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      expect(sentHeaders[1].get("traceparent")).toBe(first);
    });

    // A breadcrumb's trace_id claims the request was part of that trace, which is
    // only true for a request that carried the header. Before this module tracked
    // one trace per navigation it held a per-URL queue, so a non-target simply had
    // no entry; the URL check preserves that rather than quietly widening it.
    it("reports a trace id only for URLs it propagates to", async () => {
      window.fetch = async () => new Response();

      initNetworkHook();
      initTracing(["localhost/**"]);

      await window.fetch("http://localhost/api/users");

      expect(traceIdForUrl("http://localhost/api/users")).toBe(
        getTraceContext()!.trace_id,
      );
      expect(traceIdForUrl("http://cdn.example.com/analytics.js")).toBeUndefined();
    });

    it("keeps one identity across parallel same-URL requests", async () => {
      const sentHeaders: Headers[] = [];
      window.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        sentHeaders.push(new Headers(init?.headers));
        return new Response();
      };

      initNetworkHook();
      initTracing(["localhost/**"]);

      const url = "http://localhost/api/poll";
      await Promise.all([window.fetch(url), window.fetch(url)]);

      expect(sentHeaders[0].get("traceparent")).toBe(sentHeaders[1].get("traceparent"));
    });

    it("exposes the propagated identity for other payloads to reuse", async () => {
      const sentHeaders: Headers[] = [];
      window.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        sentHeaders.push(new Headers(init?.headers));
        return new Response();
      };

      initNetworkHook();
      initTracing(["localhost/**"]);

      await window.fetch("http://localhost/api/users");

      const [, traceFromHeader, spanFromHeader] = sentHeaders[0]
        .get("traceparent")!
        .split("-");
      expect(getTraceContext()).toEqual({
        trace_id: traceFromHeader,
        span_id: spanFromHeader,
        start_time: expect.any(Number),
      });
    });

    it("has no identity until a request has actually propagated one", async () => {
      // Nothing refers to the page load span before a traceparent goes out, so
      // there is no span, and no payload should claim there is one.
      window.fetch = async () => new Response();

      initNetworkHook();
      initTracing(["localhost/**"]);

      expect(getTraceContext()).toBeUndefined();

      await window.fetch("http://other.com/api/test");
      expect(getTraceContext()).toBeUndefined();

      await window.fetch("http://localhost/api/test");
      expect(getTraceContext()).toBeDefined();
    });

    it("declares the page load span on the first propagated request only", async () => {
      const sentHeaders: Headers[] = [];
      window.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        sentHeaders.push(new Headers(init?.headers));
        return new Response();
      };

      initNetworkHook();
      initTracing(["localhost/**"]);

      await window.fetch("http://localhost/api/one");
      await window.fetch("http://localhost/api/two");

      expect(pageLoads).toHaveLength(1);
      const [, traceFromHeader, spanFromHeader] = sentHeaders[0]
        .get("traceparent")!
        .split("-");
      expect(pageLoads[0]).toEqual({
        type: "page_load",
        trace_id: traceFromHeader,
        span_id: spanFromHeader,
        action: "/orders",
        start_time: expect.any(Number),
        tags: {},
      });
    });

    it("carries the host's app version, service name and tags", async () => {
      // These ride on the page_load post so a lost closing or error post still
      // leaves the server with the same identity it would have gotten from
      // any of the three. All three come from the config/session state, not
      // from anything trace-specific.
      tagsMock.tags = { plan: "pro" };
      window.fetch = async () => new Response();

      initNetworkHook();
      initTracing(["localhost/**"], "1.2.3", "checkout");

      await window.fetch("http://localhost/api/one");

      expect(pageLoads[0].app_version).toBe("1.2.3");
      expect(pageLoads[0].service_name).toBe("checkout");
      expect(pageLoads[0].tags).toEqual({ plan: "pro" });
    });

    it("declares nothing when no propagation targets are configured", async () => {
      // The early return has to leave the network hook untouched. When no
      // before-request listener runs, the hook passes the caller's `init`
      // object straight through instead of rebuilding it with fresh headers,
      // so object identity is what proves nothing was registered.
      let receivedInit: RequestInit | undefined;
      let capturedHeaders: Headers | undefined;
      window.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        receivedInit = init;
        capturedHeaders = new Headers(init?.headers);
        return new Response();
      };

      initNetworkHook();
      initTracing([]);

      const callerInit: RequestInit = { method: "POST" };
      await window.fetch("http://localhost/api/test", callerInit);

      expect(receivedInit).toBe(callerInit);
      expect(capturedHeaders?.get("traceparent")).toBeNull();
      expect(pageLoads).toEqual([]);
      expect(getTraceContext()).toBeUndefined();
    });

    it("starts a new trace on the next navigation", async () => {
      // Without the reset a long-lived single-page app would accumulate one
      // ever-growing trace for the whole visit.
      const sentHeaders: Headers[] = [];
      window.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        sentHeaders.push(new Headers(init?.headers));
        return new Response();
      };

      initNetworkHook();
      initTracing(["localhost/**"]);

      await window.fetch("http://localhost/api/one");
      const firstNavigation = getTraceContext();

      markTracingNavigation();
      expect(getTraceContext()).toBeUndefined();

      routeMock.action = "/invoices";
      await window.fetch("http://localhost/api/two");

      expect(getTraceContext()).not.toEqual(firstNavigation);
      expect(sentHeaders[1].get("traceparent")).not.toBe(sentHeaders[0].get("traceparent"));
      // The second navigation declares its own span, with its own action.
      expect(pageLoads).toHaveLength(2);
      expect(pageLoads[1].action).toBe("/invoices");
    });
  });
});
