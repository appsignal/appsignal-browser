import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initTracing, traceIdForRequest, destroyTracing } from "./tracing.js";
import { initNetworkHook, destroyNetworkHook, onAfterRequest } from "./network-hook.js";
import { setRouteTemplate } from "./vitals.js";

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
      setRouteTemplate(null);
      window.fetch = originalFetch;
    });

    const captureFetchHeaders = () => {
      let sent: Headers | undefined;
      window.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        sent = new Headers(init?.headers);
        return new Response();
      };
      initNetworkHook();
      return () => sent;
    };

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

    it("names this frontend as the caller in tracestate", async () => {
      const sentHeaders = captureFetchHeaders();
      initTracing(["localhost/**"], "Shop, web=1:eu;café");

      await window.fetch("http://localhost/api/test");

      expect(sentHeaders()?.get("tracestate")).toBe("appsignal=service:Shop_ web_1:eu_caf_;action:/");
    });

    it("replaces a lone surrogate in the service name instead of failing", async () => {
      const sentHeaders = captureFetchHeaders();
      initTracing(["localhost/**"], "Shop\uD800");

      await window.fetch("http://localhost/api/test");

      expect(sentHeaders()?.get("tracestate")).toBe("appsignal=service:Shop_;action:/");
    });

    it("replaces a tracestate the caller set when it starts a new trace", async () => {
      const sentHeaders = captureFetchHeaders();
      initTracing(["localhost/**"]);

      await window.fetch("http://localhost/api/test", {
        headers: { tracestate: "rojo=00f067aa0ba902b7, appsignal=service:Old" },
      });

      expect(sentHeaders()?.get("tracestate")).toBe("appsignal=service:Browser;action:/");
    });

    it("names the route template of the page, read on each request", async () => {
      const sentHeaders = captureFetchHeaders();
      initTracing(["localhost/**"], "Shop");

      setRouteTemplate("/users/:id");
      await window.fetch("http://localhost/api/test");
      expect(sentHeaders()?.get("tracestate")).toBe("appsignal=service:Shop;action:/users/:id");

      setRouteTemplate("/orders/:id");
      await window.fetch("http://localhost/api/test");
      expect(sentHeaders()?.get("tracestate")).toBe("appsignal=service:Shop;action:/orders/:id");
    });

    it("cuts the tracestate value to 256 characters", async () => {
      const sentHeaders = captureFetchHeaders();
      initTracing(["localhost/**"], "Shop");
      setRouteTemplate(`/${"a".repeat(300)}`);

      await window.fetch("http://localhost/api/test");

      const member = sentHeaders()?.get("tracestate") ?? "";
      expect(member).toMatch(/^appsignal=service:Shop;action:\/a+$/);
      expect(member.length - "appsignal=".length).toBe(256);
    });

    it("removes a space that the cut leaves at the end of the tracestate value", async () => {
      const sentHeaders = captureFetchHeaders();
      initTracing(["localhost/**"], "Shop");
      const prefix = "service:Shop;action:/";
      setRouteTemplate(`/${"a".repeat(255 - prefix.length)} b`);

      await window.fetch("http://localhost/api/test");

      expect(sentHeaders()?.get("tracestate")).toMatch(/^appsignal=service:Shop;action:\/a+$/);
    });

    it("leaves tracestate alone when it joins the trace of the caller", async () => {
      const sentHeaders = captureFetchHeaders();
      initTracing(["localhost/**"]);

      await window.fetch("http://localhost/api/test", {
        headers: {
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          tracestate: "rojo=00f067aa0ba902b7",
        },
      });

      expect(sentHeaders()?.get("tracestate")).toBe("rojo=00f067aa0ba902b7");
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
