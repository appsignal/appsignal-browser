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
