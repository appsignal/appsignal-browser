import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  initNetworkHook,
  destroyNetworkHook,
  onBeforeRequest,
  onAfterRequest,
  reportFinishedXhrs,
} from "./network-hook.js";

// Capture what underlyingFetch actually receives so we can assert on the headers
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

/** Make an XHR look finished, as jsdom never answers one on its own. */
function finish(xhr: XMLHttpRequest, status = 200): void {
  Object.defineProperty(xhr, "readyState", { value: 4, configurable: true });
  Object.defineProperty(xhr, "status", { value: status, configurable: true });
}

/** Undo `finish`, so the object reports its real state again. */
function unfinish(xhr: XMLHttpRequest): void {
  delete (xhr as { readyState?: number }).readyState;
  delete (xhr as { status?: number }).status;
}

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

  it("does not put back a header the caller replaced on a Request", async () => {
    // `new Request(input, init)` empties the header list and refills it from
    // init, so a caller who passes replacement headers has dropped the rest.
    onBeforeRequest((ctx) => { ctx.headers.set("traceparent", "00-a-b-01"); });
    const authed = new Request("https://example.com/api", {
      headers: { authorization: "Bearer SECRET", accept: "a" },
    });
    await window.fetch(authed, { headers: { accept: "b" } });

    const headers = effectiveHeaders();
    expect(headers.get("accept")).toBe("b");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("traceparent")).toBe("00-a-b-01");
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
    finish(xhr);
    xhr.dispatchEvent(new Event("load"));

    expect(order).toEqual(["sdk", "host"]);
  });

  it("does not report the next request when the host sends it from onload", () => {
    // A poll loop sends the next request from the previous one's load handler.
    // The SDK's own load listener runs after it, and must not report the new
    // request, which has not been answered yet.
    const seen: string[] = [];
    onAfterRequest((result) => { seen.push(result.url); });

    const xhr = new XMLHttpRequest();
    xhr.onload = () => {
      unfinish(xhr);
      xhr.open("GET", "https://example.com/second");
      xhr.send();
    };
    xhr.open("GET", "https://example.com/first");
    xhr.send();
    finish(xhr);
    xhr.dispatchEvent(new Event("readystatechange"));
    xhr.dispatchEvent(new Event("load"));

    expect(seen).toEqual(["https://example.com/first"]);
  });

  it("reports a finished XHR early, for a host handler that runs before the SDK's", () => {
    // A handler set before open() runs first. Code in it that asks for the
    // request it is handling must find that request already reported.
    const seen: string[] = [];
    onAfterRequest((result) => { seen.push(result.url); });
    let seenInHandler: string[] = [];

    const xhr = new XMLHttpRequest();
    xhr.onreadystatechange = () => {
      if (xhr.readyState !== 4) return;
      reportFinishedXhrs();
      seenInHandler = [...seen];
    };
    xhr.open("GET", "https://example.com/users");
    xhr.send();
    finish(xhr);
    xhr.dispatchEvent(new Event("readystatechange"));

    expect(seenInHandler).toEqual(["https://example.com/users"]);
    // Once, although the SDK's own listener ran after the early report.
    expect(seen).toEqual(["https://example.com/users"]);
  });

  it("keeps the in-flight request's record when a second send() throws", () => {
    let sends = 0;
    onBeforeRequest((ctx) => { ctx.trace = { traceId: String(++sends), spanId: "s" }; });
    const reported: unknown[] = [];
    onAfterRequest((result) => { reported.push(result.trace?.traceId); });

    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://example.com/first");
    xhr.send();
    // The object is still sending, so the native send() refuses this one.
    expect(() => xhr.send()).toThrow();
    finish(xhr);
    xhr.dispatchEvent(new Event("readystatechange"));

    expect(reported).toEqual(["1"]);
  });

  it("reports once for each send, whichever event arrives first", () => {
    // readystatechange comes before load, and an error event can follow both.
    const seen: string[] = [];
    onAfterRequest((result) => { seen.push(result.url); });

    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://example.com/once");
    xhr.send();
    finish(xhr);
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

// The record's lifecycle is what kept breaking: an event arriving while the
// object already belonged to another request. This drives every named event
// against a parked record, with and without a retry in between, and asserts
// the two invariants that were violated each time.
describe("a parked record across every ending", () => {
  const NAMED = ["load", "error", "timeout", "abort"] as const;

  for (const named of NAMED) {
    for (const retry of [false, true]) {
      it(`${named}${retry ? " with a retry in between" : ""} reports each request once, with its own status`, () => {
        const seen: { url: string; status?: number }[] = [];
        onAfterRequest((r) => seen.push({ url: r.url, status: r.status }));

        const xhr = new XMLHttpRequest();
        xhr.open("GET", "https://example.com/a");
        xhr.send();
        finish(xhr, 0);                   // finishes with no HTTP status
        xhr.dispatchEvent(new Event("readystatechange"));   // parks the record

        if (retry) {
          unfinish(xhr);
          xhr.open("GET", "https://example.com/b");
          xhr.send();
          finish(xhr, 500);               // the retry's own status
        }
        xhr.dispatchEvent(new Event(named));

        const a = seen.filter((r) => r.url.endsWith("/a"));
        // Reported once, never twice and never dropped.
        expect(a).toHaveLength(1);
        // And never wearing the retry's status.
        expect(a[0].status === undefined || a[0].status === 0).toBe(true);
        expect(seen.some((r) => r.url.endsWith("/a") && r.status === 500)).toBe(false);
      });
    }
  }
});


describe("explicit XHR completion", () => {
  it("releases an in-flight request on reopen, even without another send", () => {
    const seen: { url: string; aborted?: boolean }[] = [];
    onAfterRequest(r => seen.push({ url: r.url, aborted: r.aborted }));
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://example.com/first");
    xhr.send();
    xhr.open("GET", "https://example.com/second");
    expect(seen).toEqual([{ url: "https://example.com/first", aborted: true }]);
    finish(xhr);
    xhr.dispatchEvent(new Event("load"));
    expect(seen).toHaveLength(1);
  });
});


describe("rejected XHR reopen", () => {
  it("keeps the active request when native open rejects its arguments", () => {
    const seen: { url: string; status?: number; aborted?: boolean }[] = [];
    onAfterRequest(r => seen.push({ url: r.url, status: r.status, aborted: r.aborted }));
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://example.com/original");
    xhr.send();
    expect(() => xhr.open("INVALID METHOD", "https://example.com/next")).toThrow();
    expect(seen).toEqual([]);
    finish(xhr, 500);
    xhr.dispatchEvent(new Event("readystatechange"));
    expect(seen).toEqual([{ url: "https://example.com/original", status: 500, aborted: false }]);
  });

  it("preserves caller headers when a rejected open precedes send", () => {
    const seen: (string | null)[] = [];
    onBeforeRequest(ctx => { seen.push(ctx.headers.get("traceparent")); });
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://example.com/original");
    xhr.setRequestHeader("traceparent", "caller-context");
    expect(() => xhr.open("INVALID METHOD", "https://example.com/next")).toThrow();
    xhr.send();
    xhr.abort();
    expect(seen).toEqual(["caller-context"]);
  });
});


describe("request URL resolution", () => {
  it("resolves fetch URLs against the document base before notifying listeners", async () => {
    const base = document.createElement("base");
    base.href = "https://example.com/api/";
    document.head.append(base);
    const before = vi.fn();
    const after = vi.fn();
    onBeforeRequest(before);
    onAfterRequest(after);
    try {
      await window.fetch("echo");
      expect(before.mock.calls[0][0].url).toBe("https://example.com/api/echo");
      expect(after.mock.calls[0][0].url).toBe("https://example.com/api/echo");
      expect(lastInput).toBe("echo");
    } finally { base.remove(); }
  });

  it("keeps the XHR URL resolved at open even if the base changes before send", () => {
    const base = document.createElement("base");
    base.href = "https://example.com/api/";
    document.head.append(base);
    const before = vi.fn();
    const after = vi.fn();
    onBeforeRequest(before);
    onAfterRequest(after);
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", "echo");
      base.href = "https://other.example/";
      xhr.send();
      finish(xhr, 500);
      xhr.dispatchEvent(new Event("readystatechange"));
      expect(before.mock.calls[0][0].url).toBe("https://example.com/api/echo");
      expect(after.mock.calls[0][0].url).toBe("https://example.com/api/echo");
      unfinish(xhr);
      xhr.abort();
    } finally { base.remove(); }
  });
});


describe("request subscriber lifetime", () => {
  it.each([false, true])("isolates an old fetch after reinit (rejected: %s)", async rejected => {
    let settle!: (value: Response) => void;
    let fail!: (reason: unknown) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    }));
    const oldListener = vi.fn();
    onAfterRequest(oldListener);
    const pending = window.fetch("https://example.com/old");
    destroyNetworkHook();
    initNetworkHook();
    const newListener = vi.fn();
    onAfterRequest(newListener);
    if (rejected) {
      const reason = new DOMException("Timed out", "TimeoutError");
      fail(reason);
      await expect(pending).rejects.toBe(reason);
    } else {
      const response = new Response(null, { status: 500 });
      settle(response);
      await expect(pending).resolves.toBe(response);
    }
    expect(oldListener).not.toHaveBeenCalled();
    expect(newListener).not.toHaveBeenCalled();
    await window.fetch("https://example.com/new");
    expect(newListener).toHaveBeenCalledTimes(1);
  });

  it("isolates an old XHR and observes its reuse after reinit", () => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://example.com/old");
    xhr.send();
    destroyNetworkHook();
    initNetworkHook();
    const listener = vi.fn();
    onAfterRequest(listener);
    finish(xhr, 500);
    xhr.dispatchEvent(new Event("readystatechange"));
    expect(listener).not.toHaveBeenCalled();
    unfinish(xhr);
    xhr.open("GET", "https://example.com/new");
    xhr.send();
    finish(xhr, 503);
    xhr.dispatchEvent(new Event("readystatechange"));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatchObject({ url: "https://example.com/new", status: 503 });
    unfinish(xhr);
    xhr.abort();
  });
});

describe("a fetch input from another frame", () => {
  // Each frame has its own `Request` and `URL`, so `instanceof` against ours
  // is false for an object the host built elsewhere. Stand-ins that fail the
  // same check model that, since jsdom has no second frame to build one in.
  const foreignRequest = (init: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }): Request => {
    const real = new Request("https://example.com/api", init);
    return {
      url: real.url,
      method: real.method,
      headers: real.headers,
      signal: init.signal ?? real.signal,
      mode: real.mode,
      get [Symbol.toStringTag]() { return "Request"; },
    } as unknown as Request;
  };

  it("keeps the Request's headers and joins its trace", async () => {
    const parent = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`;
    const seen: Array<{ method: string; traceparent: string | null }> = [];
    onBeforeRequest((ctx) => {
      seen.push({ method: ctx.method, traceparent: ctx.headers.get("traceparent") });
      ctx.headers.set("x-sdk", "1");
    });
    await window.fetch(foreignRequest({ method: "POST", headers: { authorization: "Bearer SECRET", traceparent: parent } }));

    expect(seen).toEqual([{ method: "POST", traceparent: parent }]);
    const headers = new Headers(lastInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer SECRET");
    expect(headers.get("traceparent")).toBe(parent);
    expect(headers.get("x-sdk")).toBe("1");
  });

  it("reports the URL object's address", async () => {
    const listener = vi.fn();
    onAfterRequest(listener);
    const foreignUrl = { href: "https://example.com/api", toString: () => "https://example.com/api" } as unknown as URL;
    await window.fetch(foreignUrl);
    expect(listener.mock.calls[0][0]).toMatchObject({ url: "https://example.com/api", method: "GET" });
  });

  it("reports a cancel, not a timeout, for a signal that fired before the call", async () => {
    const listener = vi.fn();
    onAfterRequest(listener);
    const controller = new AbortController();
    const reason = new DOMException("Expired", "TimeoutError");
    controller.abort(reason);
    fetchMock.mockRejectedValueOnce(reason);
    await expect(window.fetch(foreignRequest({ signal: controller.signal }))).rejects.toBe(reason);
    expect(listener.mock.calls[0][0]).toMatchObject({ aborted: true, error: false, timedOut: false });
  });
});
