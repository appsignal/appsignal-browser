import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { init, destroy, captureError } from "./index.js";
import type { BrowserConfig, FrontendTransaction } from "./types.js";

const reports: FrontendTransaction[] = [];
const requests: { url: string; traceparent: string | null }[] = [];
let respond: (url: string, options?: RequestInit) => Promise<Response>;
const config = (extra: Partial<BrowserConfig> = {}) => ({
  key: "test", endpoint: "http://localhost", tracePropagationTargets: ["localhost/**"], ...extra,
});

beforeEach(() => {
  reports.length = 0;
  requests.length = 0;
  sessionStorage.clear();
  localStorage.clear();
  respond = async () => new Response(null, { status: 500 });
  vi.spyOn(window, "fetch").mockImplementation(async (input, options) => {
    const url = String(input);
    if (url.includes("/ingest/browser")) {
      expect(new Headers(options?.headers).get("traceparent")).toBeNull();
      if (url.includes("/errors")) reports.push(JSON.parse(String(options?.body)));
      return new Response();
    }
    requests.push({ url, traceparent: new Headers(options?.headers).get("traceparent") });
    return respond(url, options);
  });
});

afterEach(() => {
  destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function expectIdentity(report: FrontendTransaction, request = requests[0]) {
  const [, trace, span] = request.traceparent!.split("-");
  expect(report.trace_id).toBe(trace);
  expect(report.span_id).toBe(span);
  expect(report).not.toHaveProperty("parent_span_id");
}

function rejectGlobally(reason: unknown) {
  const event = new Event("unhandledrejection");
  Object.defineProperty(event, "reason", { value: reason });
  window.dispatchEvent(event);
}

describe("request failure traces", () => {
  it("reports a 500 as the browser root, preserving the response and scrubbing request details", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    respond = async () => {
      vi.advanceTimersByTime(12_350);
      return new Response("backend failed", { status: 500 });
    };
    init(config({ serviceName: "Checkout", privacy: { queryParamsAllowlist: ["page"] } }));
    const response = await fetch("http://localhost/api/orders?token=secret&page=2");
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("backend failed");
    expect(reports).toHaveLength(1);
    expectIdentity(reports[0]);
    expect(reports[0]).toMatchObject({
      service_name: "Checkout", start_time_ms: 1_700_000_000_000, duration_ms: 12_350,
      timestamp: 1_700_000_012,
      error: { name: "HTTPError", backtrace: [] },
      params: { request: { url: "http://localhost/api/orders?page=2", method: "GET", status: 500, duration_ms: 12_350 } },
    });
    expect(JSON.stringify(reports[0])).not.toContain("secret");
    expect(reports[0].breadcrumbs.some(b => b.metadata.trace_id === reports[0].trace_id)).toBe(true);
  });

  it("uses each concurrent same-URL request's own identity when responses arrive backwards", async () => {
    const pending: ((r: Response) => void)[] = [];
    respond = () => new Promise(resolve => pending.push(resolve));
    init(config());
    const a = fetch("http://localhost/api/orders");
    const b = fetch("http://localhost/api/orders");
    pending[1](new Response(null, { status: 503 }));
    await b;
    pending[0](new Response(null, { status: 500 }));
    await a;
    expect(reports).toHaveLength(2);
    expectIdentity(reports[0], requests[1]);
    expectIdentity(reports[1], requests[0]);
  });

  it.each([200, 204, 400, 401, 404, 429])("does not report HTTP %s", async status => {
    respond = async () => new Response(null, { status });
    init(config());
    await fetch("http://localhost/api/orders");
    expect(reports).toHaveLength(0);
  });

  it.each([
    { tracePropagationTargets: [] },
    { tracePropagationTargets: ["other.example/**"] },
    { errors: { enabled: false } },
    { errors: { sampleRate: 0 } },
    { beforeError: () => null },
    { privacy: { networkBlocklist: ["localhost/api/**"] } },
  ] satisfies Partial<BrowserConfig>[])("honors opt-in and error/privacy gates: %j", async extra => {
    init(config(extra));
    await fetch("http://localhost/api/orders");
    expect(reports).toHaveLength(0);
  });

  it("lets beforeError redact request metadata even with network breadcrumbs disabled", async () => {
    init(config({ breadcrumbs: { network: false }, beforeError: error => {
      expect(error.error_class).toBe("HTTPError");
      error.message = "redacted";
      error.context = { request: { method: "GET" } };
      return error;
    } }));
    await fetch("http://localhost/api/private");
    expect(reports[0].params).toEqual({ request: { method: "GET" } });
    expect(JSON.stringify(reports[0])).not.toContain("/api/private");
    expectIdentity(reports[0]);
  });

  it("preserves a fetch rejection and reports the same object only once", async () => {
    const failure = new DOMException("The operation timed out", "TimeoutError");
    respond = async () => { throw failure; };
    init(config());
    await expect(fetch("http://localhost/api/orders")).rejects.toBe(failure);
    rejectGlobally(failure);
    captureError(failure);
    expect(reports).toHaveLength(1);
    expect(reports[0].error.name).toBe("TimeoutError");
    expectIdentity(reports[0]);
    captureError(new Error("rendering failed"));
    expect(reports).toHaveLength(2);
    expect(reports[1].trace_id).toBeUndefined();
  });

  it("reports nothing for requests that failed while the device was offline", async () => {
    // Without this the retry queue fills with one report per attempt, and they
    // all arrive the moment connectivity returns.
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    respond = async () => { throw new DOMException("The operation timed out", "TimeoutError"); };
    init(config());

    await fetch("http://localhost/api/one").catch(() => {});
    await fetch("http://localhost/api/two").catch(() => {});

    onLine.mockReturnValue(true);
    window.dispatchEvent(new Event("online"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reports).toEqual([])
  });

  it("keeps a later JS error independent after HTTP failure", async () => {
    init(config());
    await fetch("http://localhost/api/orders");
    captureError(new Error("Could not render orders"));
    expect(reports).toHaveLength(2);
    expect(reports[1].span_id).toBeUndefined();
  });

  it("does not suppress the original rejection if beforeError drops the request report", async () => {
    const failure = new DOMException("The operation timed out", "TimeoutError");
    respond = async () => { throw failure; };
    // Both reports carry the same class now, so the request details are what
    // tell the dropped request report from the rejection that follows it.
    init(config({ beforeError: e => e.context?.request ? null : e }));
    await fetch("http://localhost/api/orders").catch(() => {});
    rejectGlobally(failure);
    expect(reports).toHaveLength(1);
    expect(reports[0].error.name).toBe("TimeoutError");
    expect(reports[0].error.message).toBe("The operation timed out");
    expect(reports[0].trace_id).toBeUndefined();
  });

  it("ignores intentional aborts including custom reasons, but reports timeouts", async () => {
    init(config());
    for (const reason of [new DOMException("cancelled", "AbortError"), new Error("navigation")]) {
      const controller = new AbortController();
      controller.abort(reason);
      respond = async () => { throw reason; };
      await expect(fetch("http://localhost/api/orders", { signal: controller.signal })).rejects.toBe(reason);
    }
    expect(reports).toHaveLength(0);
    // A real deadline fires while the request is in flight. One that fired
    // before the call is a different thing, covered below.
    const timeout = new DOMException("Timed out", "TimeoutError");
    const controller = new AbortController();
    let failRequest!: (reason: unknown) => void;
    respond = () => new Promise((_, reject) => { failRequest = reject; });
    const inFlight = fetch("http://localhost/api/orders", { signal: controller.signal });
    controller.abort(timeout);
    failRequest(timeout);
    await expect(inFlight).rejects.toBe(timeout);
    expect(reports).toHaveLength(1);
    expect(reports[0].error.name).toBe("TimeoutError");
    expectIdentity(reports[0], requests[2]);
  });

  it("does not report a request whose deadline expired before it was sent", async () => {
    // `AbortSignal.timeout()` reused across retries. fetch rejects without
    // sending, so the request says nothing about the backend, and a report
    // would invent a span no backend span can ever join.
    const expired = new DOMException("Timed out", "TimeoutError");
    const controller = new AbortController();
    controller.abort(expired);
    init(config());
    respond = async () => { throw expired; };
    await fetch("http://localhost/api/orders", { signal: controller.signal }).catch(() => {});
    expect(reports).toHaveLength(0);
  });

  it.each([500, 503])("reports XHR status %s once with its own identity", status => {
    vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => {});
    const headers: string[] = [];
    vi.spyOn(XMLHttpRequest.prototype, "setRequestHeader").mockImplementation((name, value) => {
      if (name === "traceparent") headers.push(value);
    });
    init(config());
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "http://localhost/api/orders");
    xhr.send();
    Object.defineProperty(xhr, "readyState", { value: 4 });
    Object.defineProperty(xhr, "status", { value: status });
    xhr.dispatchEvent(new Event("readystatechange"));
    xhr.dispatchEvent(new Event("load"));
    expect(reports).toHaveLength(1);
    expectIdentity(reports[0], { url: "", traceparent: headers[0] });
    expect(reports[0].error.name).toBe("HTTPError");
  });

  it("reports the timed-out XHR even when the host retries on the same object", () => {
    vi.useFakeTimers();
    vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => {});
    init(config());

    const xhr = new XMLHttpRequest();
    xhr.open("GET", "http://localhost/api/orders");
    xhr.timeout = 100;
    // Registered after open(), so it runs after the SDK's listener and inside
    // the window between readystatechange and the timeout event.
    xhr.addEventListener("readystatechange", () => {
      if (xhr.readyState === 4 && xhr.status === 0) {
        xhr.open("GET", "http://localhost/api/orders");
        xhr.send();
      }
    });
    xhr.send();
    vi.advanceTimersByTime(500);

    let state = 4;
    Object.defineProperty(xhr, "readyState", { get: () => state, configurable: true });
    Object.defineProperty(xhr, "status", { value: 0, configurable: true });
    xhr.dispatchEvent(new Event("readystatechange"));
    // open() put the object back to OPENED for the retry.
    state = 1;
    xhr.dispatchEvent(new Event("timeout"));

    expect(reports).toHaveLength(1);
    expect(reports[0].error.name).toBe("TimeoutError");
  });

  it("reports a 500 the host reopened before the SDK's listener ran", () => {
    vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => {});
    init(config());

    let state = 4;
    const xhr = new XMLHttpRequest();
    // Set before open(), so this runs ahead of the SDK's listener and the
    // reopen lands before the SDK ever sees DONE.
    xhr.onreadystatechange = () => {
      if (xhr.readyState === 4 && xhr.status === 500) {
        xhr.open("GET", "http://localhost/api/orders");
        state = 1; // open() puts the object back to OPENED
        xhr.send();
      }
    };
    xhr.open("GET", "http://localhost/api/orders");
    xhr.send();

    Object.defineProperty(xhr, "readyState", { get: () => state, configurable: true });
    Object.defineProperty(xhr, "status", { get: () => (state === 4 ? 500 : 0), configurable: true });
    xhr.dispatchEvent(new Event("readystatechange"));

    expect(reports).toHaveLength(1);
    expect(reports[0].error.name).toBe("HTTPError");
    expect(reports[0].params).toMatchObject({ request: { status: 500 } });
  });

  it("holds back the rejection of a request it stopped reporting", async () => {
    // Past the dedupe cap the SDK sends nothing, so the same rejection must
    // not arrive through `unhandledrejection` as an untraced error that no
    // longer names the endpoint.
    respond = async () => { throw new DOMException("The operation timed out", "TimeoutError"); };
    init(config());
    for (let i = 0; i < 6; i++) {
      const failure = await fetch("http://localhost/api/orders").catch(e => e);
      rejectGlobally(failure);
    }

    expect(reports).toHaveLength(5);
    expect(reports.every(report => report.trace_id)).toBe(true);
  });

  it("reports a held-back request again once the window has passed", async () => {
    // The gates that hold it back are windowed, so the hold must be too. A ten
    // second storm must not silence the object for the life of the page.
    vi.useFakeTimers();
    respond = async () => { throw new DOMException("The operation timed out", "TimeoutError"); };
    init(config());
    const failures: unknown[] = [];
    for (let i = 0; i < 6; i++) {
      failures.push(await fetch("http://localhost/api/orders").catch(e => e));
    }
    reports.length = 0;
    vi.advanceTimersByTime(11_000);
    rejectGlobally(failures[5]);

    expect(reports).toHaveLength(1);
  });

  it("runs captureError for a request it only held back", async () => {
    // The host asked for this one by hand, and no report exists for it.
    respond = async () => { throw new DOMException("The operation timed out", "TimeoutError"); };
    init(config());
    let last: unknown;
    for (let i = 0; i < 6; i++) last = await fetch("http://localhost/api/orders").catch(e => e);
    reports.length = 0;
    captureError(last as Error, { componentName: "OrderList" });

    expect(reports).toHaveLength(1);
  });

  it("rolls the sample once for a request failure, not once per route", async () => {
    respond = async () => { throw new DOMException("The operation timed out", "TimeoutError"); };
    init(config({ errors: { sampleRate: 0.5 } }));
    const rolls = [0.9, 0.1];
    vi.spyOn(Math, "random").mockImplementation(() => rolls.shift() ?? 0.1);
    const failure = await fetch("http://localhost/api/orders").catch(e => e);
    rejectGlobally(failure);

    expect(reports).toHaveLength(0);
  });

  it.each(["fetch", "xhr"] as const)("joins the trace the caller's own traceparent names, over %s", async transport => {
    const traceId = "a".repeat(32);
    const spanId = "b".repeat(16);
    const header = `00-${traceId}-${spanId}-01`;
    respond = async () => new Response(null, { status: 500 });
    // Before init(), or the spy would replace the SDK's own patched send.
    vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => {});
    init(config());

    if (transport === "fetch") {
      await fetch("http://localhost/api/orders", { headers: { traceparent: header } });
    } else {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "http://localhost/api/orders");
      xhr.setRequestHeader("traceparent", header);
      xhr.send();
      Object.defineProperty(xhr, "readyState", { get: () => 4, configurable: true });
      Object.defineProperty(xhr, "status", { get: () => 500, configurable: true });
      xhr.dispatchEvent(new Event("readystatechange"));
    }

    expect(reports).toHaveLength(1);
    expect(reports[0].trace_id).toBe(traceId);
    expect(reports[0].span_id).toBe(spanId);
  });

  it("leaves a traceparent the host set on an XHR alone", () => {
    // setRequestHeader combines values, so setting ours over the host's would
    // send one malformed header that a conformant backend rejects whole.
    const sent: [string, string][] = [];
    vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => {});
    const realSet = XMLHttpRequest.prototype.setRequestHeader;
    vi.spyOn(XMLHttpRequest.prototype, "setRequestHeader").mockImplementation(
      function (this: XMLHttpRequest, name: string, value: string) {
        sent.push([name, value]);
        return realSet.call(this, name, value);
      },
    );
    init(config());
    const hostValue = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`;
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "http://localhost/api/orders");
    xhr.setRequestHeader("traceparent", hostValue);
    xhr.send();

    expect(sent.filter(([name]) => name.toLowerCase() === "traceparent"))
      .toEqual([["traceparent", hostValue]]);
  });

  it("does not emit a parked record against the next request's status", () => {
    // The host resends from its own `load` handler, registered before open(),
    // so the object is back at OPENED when the SDK's listener runs.
    vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => {});
    init(config());
    const xhr = new XMLHttpRequest();
    let state = 1;
    let status = 0;
    let retried = false;
    Object.defineProperty(xhr, "readyState", { get: () => state, configurable: true });
    Object.defineProperty(xhr, "status", { get: () => status, configurable: true });

    xhr.onload = () => {
      if (retried) return;
      retried = true;
      state = 1;
      xhr.open("GET", "http://localhost/api/b");
      xhr.send();
    };
    xhr.open("GET", "http://localhost/api/config");
    xhr.send();

    state = 4; status = 0;        // a `file:`-style success
    xhr.dispatchEvent(new Event("readystatechange"));
    xhr.dispatchEvent(new Event("load"));

    state = 4; status = 500;      // the retry answers 500
    xhr.dispatchEvent(new Event("readystatechange"));
    xhr.dispatchEvent(new Event("load"));

    // /api/config succeeded with status 0, so only the retry is an error.
    expect(reports).toHaveLength(1);
    expect((reports[0].params as { request: { url: string } }).request.url)
      .toBe("http://localhost/api/b");
  });

  it("does not report a stale request after a status 0 that succeeded", () => {
    vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => {});
    init(config());
    const xhr = new XMLHttpRequest();
    let state = 1;
    Object.defineProperty(xhr, "readyState", { get: () => state, configurable: true });
    Object.defineProperty(xhr, "status", { value: 0, configurable: true });

    // A `file:` URL finishes with status 0 and fires `load`, never a named event.
    xhr.open("GET", "http://localhost/api/first");
    xhr.send();
    state = 4;
    xhr.dispatchEvent(new Event("readystatechange"));
    xhr.dispatchEvent(new Event("load"));

    state = 1;
    xhr.open("GET", "http://localhost/api/second");
    xhr.send();
    state = 4;
    xhr.dispatchEvent(new Event("timeout"));

    expect(reports).toHaveLength(1);
    expect((reports[0].params as { request: { url: string } }).request.url)
      .toBe("http://localhost/api/second");
  });

  it("does not report a request that never reached the backend", async () => {
    // Refused, undeliverable or blocked by an extension. The browser reports
    // all of them as one TypeError, and none of them leaves a span to join.
    respond = async () => { throw new TypeError("Failed to fetch"); };
    init(config());
    await fetch("http://localhost/api/orders").catch(() => {});
    expect(reports).toHaveLength(0);
  });

  it("reports the XHR the browser timed out, and not the one it failed", () => {
    vi.useFakeTimers();
    vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => {});
    init(config());

    // A blocked main thread delivers the failure past the deadline. Only the
    // event says which failure it was, so elapsed time must not decide.
    const failed = new XMLHttpRequest();
    failed.open("GET", "http://localhost/api/orders");
    failed.timeout = 200;
    failed.send();
    vi.advanceTimersByTime(500);
    Object.defineProperty(failed, "readyState", { value: 4 });
    Object.defineProperty(failed, "status", { value: 0 });
    failed.dispatchEvent(new Event("error"));
    expect(reports).toHaveLength(0);

    const timedOut = new XMLHttpRequest();
    timedOut.open("GET", "http://localhost/api/orders");
    timedOut.timeout = 5_000;
    timedOut.send();
    vi.advanceTimersByTime(5_000);
    Object.defineProperty(timedOut, "readyState", { value: 4 });
    Object.defineProperty(timedOut, "status", { value: 0 });
    timedOut.dispatchEvent(new Event("timeout"));
    expect(reports).toHaveLength(1);
    expect(reports[0].error.name).toBe("TimeoutError");
    expect(reports[0].params).toMatchObject({ request: { duration_ms: 5_000 } });
  });

  it("ignores cancelled XHRs", () => {
    vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => {});
    init(config());
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "http://localhost/api/orders");
    xhr.send();
    xhr.abort();
    Object.defineProperty(xhr, "readyState", { value: 4 });
    xhr.dispatchEvent(new Event("readystatechange"));
    expect(reports).toHaveLength(0);
  });
});


describe("trace headers on the wire", () => {
  const traceId = "a".repeat(32);
  const spanId = "b".repeat(16);
  const valid = `00-${traceId}-${spanId}-01`;
  const malformed = [
    "invalid", `00-${traceId}-${spanId}`, `ff-${traceId}-${spanId}-01`,
    `zz-${traceId}-${spanId}-01`, `00-${traceId}-${spanId}-gg`,
    `${valid}-extra`, `${valid}, ${valid}`, `00-${"0".repeat(32)}-${spanId}-01`,
  ];

  it.each(malformed)("replaces malformed fetch context: %s", async traceparent => {
    init(config());
    await fetch("http://localhost/api/orders", { headers: { traceparent } });
    expect(reports).toHaveLength(1);
    expectIdentity(reports[0]);
    expect(requests[0].traceparent).not.toBe(traceparent);
    expect(requests[0].traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it.each(malformed)("does not invent an identity for malformed XHR context: %s", traceparent => {
    vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => {});
    init(config());
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "http://localhost/api/orders");
    xhr.setRequestHeader("traceparent", traceparent);
    xhr.send();
    Object.defineProperty(xhr, "readyState", { value: 4 });
    Object.defineProperty(xhr, "status", { value: 500 });
    xhr.dispatchEvent(new Event("readystatechange"));
    expect(reports).toHaveLength(0);
  });

  it("uses the combined XHR header rather than its last appended value", () => {
    vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => {});
    init(config());
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "http://localhost/api/orders");
    xhr.setRequestHeader("traceparent", valid);
    xhr.setRequestHeader("traceparent", valid);
    xhr.send();
    Object.defineProperty(xhr, "readyState", { value: 4 });
    Object.defineProperty(xhr, "status", { value: 500 });
    xhr.dispatchEvent(new Event("readystatechange"));
    expect(reports).toHaveLength(0);
  });

  it("adopts a future-version header with the required fields", async () => {
    init(config());
    await fetch("http://localhost/api/orders", { headers: { traceparent: `01-${traceId}-${spanId}-01-extra` } });
    expect(reports).toHaveLength(1);
    expectIdentity(reports[0]);
    expect(reports[0].trace_id).toBe(traceId);
  });
});


describe("XHR header application", () => {
  it("adopts a caller header with surrounding HTTP whitespace", () => {
    vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => {});
    init(config());
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "http://localhost/api/orders");
    xhr.setRequestHeader("traceparent", ` 00-${"a".repeat(32)}-${"b".repeat(16)}-01 `);
    xhr.send();
    Object.defineProperty(xhr, "readyState", { value: 4 });
    Object.defineProperty(xhr, "status", { value: 500 });
    xhr.dispatchEvent(new Event("readystatechange"));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ trace_id: "a".repeat(32), span_id: "b".repeat(16) });
  });

  it("does not claim trace context when header application throws", () => {
    vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => {});
    vi.spyOn(XMLHttpRequest.prototype, "setRequestHeader").mockImplementation(() => { throw new Error("header refused"); });
    init(config());
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "http://localhost/api/orders");
    expect(() => xhr.send()).not.toThrow();
    Object.defineProperty(xhr, "readyState", { value: 4 });
    Object.defineProperty(xhr, "status", { value: 500 });
    xhr.dispatchEvent(new Event("readystatechange"));
    expect(reports).toHaveLength(0);
  });
});


describe("fetch no-cors mode", () => {
  it.each(["init", "request"] as const)("skips tracing for no-cors mode from %s", async source => {
    const timeout = new DOMException("Timed out", "TimeoutError");
    respond = async () => { throw timeout; };
    init(config());
    const input = source === "request"
      ? new Request("http://localhost/api/orders", { mode: "no-cors" })
      : "http://localhost/api/orders";
    await fetch(input, source === "init" ? { mode: "no-cors" } : undefined).catch(() => {});
    expect(requests[0].traceparent).toBeNull();
    expect(reports).toEqual([]);
  });

  it("traces when init overrides a Request's no-cors mode", async () => {
    init(config());
    const input = new Request("http://localhost/api/orders", { mode: "no-cors" });
    await fetch(input, { mode: "cors" });
    expect(requests[0].traceparent).toMatch(/^00-/);
    expect(reports).toHaveLength(1);
    expectIdentity(reports[0]);
  });
});


describe("shared URL-pattern policy", () => {
  it("traces a portless uppercase host target on a non-default port", async () => {
    init(config({ tracePropagationTargets: ["LOCALHOST"] }));
    await fetch("http://localhost:8443/api/orders");
    expect(reports).toHaveLength(1);
    expectIdentity(reports[0]);
  });

  it("applies host-only blocklists to request errors on every port", async () => {
    init(config({ tracePropagationTargets: ["localhost/**"], privacy: { networkBlocklist: ["LOCALHOST"] } }));
    await fetch("http://localhost:8443/api/orders");
    expect(requests[0].traceparent).not.toBeNull();
    expect(reports).toHaveLength(0);
  });
});
