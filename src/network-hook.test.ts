import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  initNetworkHook,
  destroyNetworkHook,
  onBeforeRequest,
  onAfterRequest,
} from "./network-hook.js";
import { initTracing, consumeTraceId, destroyTracing } from "./tracing.js";

// Capture what origFetch actually receives so we can assert on the headers
// the wrapper forwards. The real network never runs.
let lastInput: RequestInfo | URL;
let lastInit: RequestInit | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

/** Resolve the effective headers the way the platform would for
 * `fetch(input, init)` — Request headers as the base, init headers overriding
 * — so the assertion reflects what the server would actually see. */
function effectiveHeaders(): Headers {
  return new Request(lastInput as Request | string, lastInit).headers;
}

beforeEach(() => {
  lastInit = undefined;
  fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    lastInput = input;
    lastInit = init;
    return Promise.resolve(new Response("ok", { status: 200 }));
  });
  window.fetch = fetchMock as unknown as typeof window.fetch;
  initNetworkHook();
});

afterEach(() => {
  destroyNetworkHook();
});

describe("network-hook fetch header preservation", () => {
  it("preserves headers carried on a Request input (no init)", async () => {
    const req = new Request("https://example.com/api", {
      headers: { authorization: "Bearer SECRET", "x-custom": "1" },
    });
    await window.fetch(req);

    const headers = effectiveHeaders();
    expect(headers.get("authorization")).toBe("Bearer SECRET");
    expect(headers.get("x-custom")).toBe("1");
  });

  it("preserves Request headers when init carries unrelated options", async () => {
    const req = new Request("https://example.com/api", {
      headers: { authorization: "Bearer SECRET" },
    });
    await window.fetch(req, { method: "POST", body: "x" });

    expect(effectiveHeaders().get("authorization")).toBe("Bearer SECRET");
  });

  it("preserves headers passed via init on a string URL", async () => {
    await window.fetch("https://example.com/api", {
      headers: { authorization: "Bearer SECRET" },
    });

    expect(effectiveHeaders().get("authorization")).toBe("Bearer SECRET");
  });

  it("lets a before-listener add a header without clobbering the caller's", async () => {
    onBeforeRequest((ctx) => ctx.headers.set("traceparent", "00-abc-def-01"));

    const req = new Request("https://example.com/api", {
      headers: { authorization: "Bearer SECRET" },
    });
    await window.fetch(req);

    // The wrapper forwards an explicit headers object in this path; assert on
    // it directly so we know the listener's header rode along with the
    // caller's, neither dropped.
    const forwarded = new Headers(lastInit?.headers);
    expect(forwarded.get("authorization")).toBe("Bearer SECRET");
    expect(forwarded.get("traceparent")).toBe("00-abc-def-01");
  });
});

describe("network-hook teardown that the browser refuses", () => {
  it("does not wrap its own wrapper when the fetch restore fails", async () => {
    // A frozen or foreign-owned global refuses the restore. `installed` says
    // our patch is on the global, so it must stay up: a second init over our
    // own wrapper would dispatch every request twice, once per layer.
    const calls: string[] = [];
    const fetchMock = vi.fn(() => Promise.resolve(new Response("ok")));
    // The shared beforeEach already patched; start from a clean global.
    destroyNetworkHook();
    window.fetch = fetchMock as unknown as typeof window.fetch;
    initNetworkHook();
    onBeforeRequest((ctx) => { calls.push(ctx.url); });

    const patched = window.fetch;
    Object.defineProperty(window, "fetch", { value: patched, writable: false, configurable: true });
    destroyNetworkHook();
    initNetworkHook();
    onBeforeRequest((ctx) => { calls.push(ctx.url); });

    await window.fetch("https://example.com/once");

    expect(calls).toEqual(["https://example.com/once"]);
    Object.defineProperty(window, "fetch", { value: fetchMock, writable: true, configurable: true });
    destroyNetworkHook();
  });

  it("notifies after-listeners before a host XHR load handler", () => {
    // Listeners run in registration order, and a host attaches between open()
    // and send(), so the SDK must register first.
    const order: string[] = [];
    onAfterRequest(() => { order.push("sdk"); });

    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://example.com/api/thing");
    xhr.addEventListener("load", () => { order.push("host"); });
    xhr.send();
    xhr.dispatchEvent(new Event("load"));

    expect(order).toEqual(["sdk", "host"]);
  });

  it("reports the request that send() started, not a later open()", () => {
    // A poll loop can re-open the object before the previous load arrives.
    const seen: { url: string; status?: number }[] = [];
    onAfterRequest((result) => { seen.push({ url: result.url, status: result.status }); });

    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://example.com/first");
    xhr.send();
    // The host starts the next request before the first one reports.
    xhr.open("GET", "https://example.com/second");
    xhr.dispatchEvent(new Event("load"));

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://example.com/first");
  });

  it("reports once for each send, whichever event arrives first", () => {
    // readystatechange comes before load, and an error event can follow both.
    const seen: string[] = [];
    onAfterRequest((result) => { seen.push(result.url); });

    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://example.com/once");
    xhr.send();
    xhr.dispatchEvent(new Event("load"));
    xhr.dispatchEvent(new Event("error"));

    expect(seen).toEqual(["https://example.com/once"]);
  });

  it("reports an aborted request as cancelled, not as a failure", () => {
    // abort() reaches readyState 4 with status 0 and never fires `error`.
    const seen: { url: string; error: boolean; aborted?: boolean }[] = [];
    onAfterRequest((result) => {
      seen.push({ url: result.url, error: result.error, aborted: result.aborted });
    });

    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://example.com/slow");
    xhr.send();
    xhr.abort();

    expect(seen).toEqual([
      { url: "https://example.com/slow", error: false, aborted: true },
    ]);
  });

  it("does not report a request with an unknown url", () => {
    // Opened before the patch, so there is no url worth a buffer slot.
    destroyNetworkHook();
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://example.com/early");

    initNetworkHook();
    const seen: string[] = [];
    onAfterRequest((result) => { seen.push(result.url); });

    xhr.send();
    xhr.dispatchEvent(new Event("load"));

    expect(seen.filter((u) => u === "")).toHaveLength(0);
  });

  it("reports a cancelled fetch as cancelled, not as a failure", async () => {
    const seen: { error: boolean; aborted?: boolean }[] = [];
    onAfterRequest((result) => { seen.push({ error: result.error, aborted: result.aborted }); });

    const abortError = new Error("The operation was aborted.");
    abortError.name = "AbortError";
    fetchMock.mockRejectedValueOnce(abortError);

    await window.fetch("https://example.com/api/search").catch(() => {});

    expect(seen).toEqual([{ error: false, aborted: true }]);
  });
});
