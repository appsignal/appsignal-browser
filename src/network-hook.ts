// Centralised fetch/XHR patch. Tracing and breadcrumbs both want to observe
// or modify network calls; without a shared hook each module patches
// window.fetch / XMLHttpRequest independently and the destroy chain has to
// unwind in the exact reverse of the patch order, otherwise window.fetch is
// left pointing at an orphaned wrapper. One patch with subscribers is the
// same pattern the navigation hook in breadcrumbs.ts already uses.

import { attemptCleanup } from "./utils.js";

export interface RequestContext {
  url: string;
  method: string;
  /** Mutable headers. Before-listeners may add or replace entries; the
   * resulting Headers object is applied to the outgoing request. */
  headers: Headers;
  /** Set by a before-listener that propagates trace context. The
   * RequestResult of the same request carries it back. */
  trace?: PropagatedTrace;
}

/** The ids a request put in its `traceparent` header. */
export interface PropagatedTrace {
  traceId: string;
  spanId: string;
}

export interface RequestResult {
  url: string;
  method: string;
  startTime: number;
  endTime: number;
  /** Status code when a response was received. Missing on network error. */
  status?: number;
  /** True only for transport failures where no response was received
   * (thrown fetch, XHR error event). A non-2xx response is *not* an error
   * here — the request completed; the application code may treat the
   * status code however it wants. Listeners that want to flag 4xx/5xx
   * should inspect `status` themselves. */
  error: boolean;
  /** The browser timed the request out, as its own `timeout` event says. A
   * subset of `error`: the server usually received it, unlike a refused or
   * undeliverable request. */
  timedOut?: boolean;
  /** Original fetch rejection, used to avoid reporting the same object twice. */
  failureReason?: unknown;
  /** The host cancelled it. Still reported, but `error` stays false. */
  aborted?: boolean;
  /** Set for fetch responses. Listeners must `.clone()` before reading. */
  response?: Response;
  /** Set for XHR responses. */
  xhr?: XMLHttpRequest;
  /** What a before-listener set on the RequestContext. */
  trace?: PropagatedTrace;
}

export type BeforeRequestListener = (ctx: RequestContext) => void;
export type AfterRequestListener = (result: RequestResult) => void;

let beforeListeners: BeforeRequestListener[] = [];
let afterListeners: AfterRequestListener[] = [];

let installed = false;
let underlyingFetch: typeof window.fetch;
let underlyingXhrOpen: typeof XMLHttpRequest.prototype.open;
let underlyingXhrSend: typeof XMLHttpRequest.prototype.send;
let underlyingXhrAbort: typeof XMLHttpRequest.prototype.abort;
let underlyingXhrSetHeader: typeof XMLHttpRequest.prototype.setRequestHeader;
const xhrsToReport = new Set<XhrState>();

/** Register a before-request listener. Returns an unregister fn. */
export function onBeforeRequest(fn: BeforeRequestListener): () => void {
  beforeListeners.push(fn);
  return () => {
    const i = beforeListeners.indexOf(fn);
    if (i >= 0) beforeListeners.splice(i, 1);
  };
}

/** Register an after-request listener. Returns an unregister fn. */
export function onAfterRequest(fn: AfterRequestListener): () => void {
  afterListeners.push(fn);
  return () => {
    const i = afterListeners.indexOf(fn);
    if (i >= 0) afterListeners.splice(i, 1);
  };
}

/** The fetch the hook wrapped, or the global one when the hook is not
 * installed. The SDK sends its own posts through this, so they reach no
 * listener: they must not carry a traceparent, show up as a breadcrumb or
 * produce an automatic request-error report. */
export function fetchPastHook(): typeof window.fetch {
  return installed ? underlyingFetch : window.fetch;
}

export function initNetworkHook(): void {
  if (installed) return;
  installed = true;
  patchFetch();
  patchXhr();
}

export function destroyNetworkHook(): void {
  if (!installed) return;
  // Drop the subscriber references first, so a failed restore does not retain
  // them. `installed` says our patch is on the globals, so it goes down only
  // for the ones we put back: a later init must not wrap our own wrapper,
  // which would dispatch every request twice and grow with each cycle.
  beforeListeners = [];
  afterListeners = [];
  xhrsToReport.clear();
  let restored = true;
  if (underlyingFetch) {
    restored = attemptCleanup("fetch patch", () => { window.fetch = underlyingFetch; }) && restored;
  }
  if (underlyingXhrOpen) {
    restored = attemptCleanup("xhr open patch", () => { XMLHttpRequest.prototype.open = underlyingXhrOpen; }) && restored;
  }
  if (underlyingXhrSend) {
    restored = attemptCleanup("xhr send patch", () => { XMLHttpRequest.prototype.send = underlyingXhrSend; }) && restored;
  }
  if (underlyingXhrSetHeader) {
    restored = attemptCleanup("xhr header patch", () => { XMLHttpRequest.prototype.setRequestHeader = underlyingXhrSetHeader; }) && restored;
  }
  if (underlyingXhrAbort) {
    restored = attemptCleanup("xhr abort patch", () => { XMLHttpRequest.prototype.abort = underlyingXhrAbort; }) && restored;
  }
  installed = !restored;
}

function patchFetch(): void {
  underlyingFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method =
      (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    const startTime = Date.now();
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    // A signal that fired before this call means the request never goes out, so
    // nothing about it says anything about the server. `AbortSignal.timeout()`
    // reused across retries is the way this happens.
    const abortedBeforeSend = Boolean(signal?.aborted);
    let trace: PropagatedTrace | undefined;

    // Default path: no before-listeners (tracing is the only one, and only
    // when tracePropagationTargets is configured). Pass `init` straight
    // through so headers carried on a `Request` input — Authorization,
    // Content-Type, custom — survive. Rebuilding init with a fresh
    // `new Headers(init?.headers)` would be empty for a `fetch(request)` call
    // and silently drop every header the caller set on the Request.
    let finalInit = init;
    const mode = init?.mode ?? (input instanceof Request ? input.mode : undefined);
    // The browser silently strips traceparent in no-cors mode.
    if (beforeListeners.length > 0 && mode !== "no-cors") {
      // The platform replaces rather than merges: `new Request(input, init)`
      // empties the request's header list and refills it from `init.headers`
      // when that member is present. Seeding from both would put back a header
      // the caller removed, an Authorization among them.
      const headers = init?.headers
        ? new Headers(init.headers)
        : new Headers(input instanceof Request ? input.headers : undefined);

      const ctx: RequestContext = { url, method, headers };
      for (const listener of beforeListeners) {
        try { listener(ctx); } catch { /* never let one listener break the chain */ }
      }
      trace = ctx.trace;
      finalInit = { ...init, headers };
    }

    try {
      const response = await underlyingFetch(input, finalInit);
      const result: RequestResult = {
        url,
        method,
        startTime,
        endTime: Date.now(),
        status: response.status,
        error: false,
        response,
        trace,
      };
      for (const listener of afterListeners) {
        try { listener(result); } catch { /* swallow */ }
      }
      return response;
    } catch (err) {
      // A cancelled fetch rejects with AbortError, which is not a failure.
      const name = (err as { name?: string } | null)?.name;
      // Custom abort reasons still mean cancellation. TimeoutError is a
      // failed request, including AbortSignal.timeout().
      const aborted = abortedBeforeSend
        || name === "AbortError"
        || (signal?.aborted === true && name !== "TimeoutError");
      const result: RequestResult = {
        url,
        method,
        startTime,
        endTime: Date.now(),
        error: !aborted,
        timedOut: !aborted && name === "TimeoutError",
        failureReason: err,
        aborted,
        trace,
      };
      for (const listener of afterListeners) {
        try { listener(result); } catch { /* swallow */ }
      }
      throw err;
    }
  };
}

/** Header state belongs to a successful open(), including headers applied
 * before a send() that the platform rejected. */
type PreparedXhr = {
  url: string;
  method: string;
  headers: Map<string, string>;
};

type XhrRecord = {
  prepared: PreparedXhr;
  startTime: number;
  endTime?: number;
  status?: number;
  cancelled: boolean;
  completed: boolean;
  trace?: PropagatedTrace;
};

type XhrOutcome =
  | { kind: "response"; status: number }
  | { kind: "timeout" }
  | { kind: "network-error" }
  | { kind: "cancelled" };

type XhrState = {
  xhr: XMLHttpRequest;
  prepared?: PreparedXhr;
  active?: XhrRecord;
  // DONE records retain a terminal-event marker after reporting a response.
  // Browser events nest synchronously: a retry's load must consume its own
  // marker before the interrupted timeout consumes the original marker.
  endings: XhrRecord[];
};

const xhrStates = new WeakMap<XMLHttpRequest, XhrState>();

function trackXhr(state: XhrState): void {
  if (state.active || state.endings.some(record => !record.completed)) {
    xhrsToReport.add(state);
  } else {
    xhrsToReport.delete(state);
  }
}

function captureXhrDone(state: XhrState, record: XhrRecord): void {
  record.status = state.xhr.status;
  record.endTime ??= Date.now();
  if (state.active === record) state.active = undefined;
  if (!state.endings.includes(record)) state.endings.push(record);
  trackXhr(state);
}

/** Settle an explicit record exactly once, without consulting mutable native
 * state. Completion data was captured before host callbacks could reset it. */
function settleXhr(state: XhrState, record: XhrRecord, outcome: XhrOutcome): void {
  if (record.completed) return;
  record.completed = true;
  if (state.active === record) state.active = undefined;
  trackXhr(state);
  const result: RequestResult = {
    url: record.prepared.url,
    method: record.prepared.method,
    startTime: record.startTime,
    endTime: record.endTime ?? Date.now(),
    error: outcome.kind === "timeout" || outcome.kind === "network-error",
    timedOut: outcome.kind === "timeout",
    aborted: outcome.kind === "cancelled",
    ...(outcome.kind === "response" ? { status: outcome.status } : {}),
    xhr: state.xhr,
    trace: record.trace,
  };
  for (const listener of afterListeners) {
    try { listener(result); } catch { /* swallow */ }
  }
}

function endXhr(state: XhrState, kind: XhrOutcome["kind"]): void {
  // Some wrappers dispatch the named event without a readystatechange first.
  if (state.endings.length === 0 && state.active && state.xhr.readyState === 4) captureXhrDone(state, state.active);
  const record = state.endings.pop();
  if (!record) return;
  const outcome: XhrOutcome = record.cancelled || kind === "cancelled"
    ? { kind: "cancelled" }
    : kind === "response"
      ? { kind: "response", status: record.status ?? 0 }
      : { kind };
  settleXhr(state, record, outcome);
  trackXhr(state);
}

/** Make completed HTTP responses available to an early host handler. A
 * status-zero request must wait for its named event to classify the failure. */
export function reportFinishedXhrs(): void {
  for (const state of xhrsToReport) {
    const record = state.active;
    if (!record || state.xhr.readyState !== 4) continue;
    captureXhrDone(state, record);
    if (record.status !== 0) settleXhr(state, record, { kind: "response", status: record.status! });
  }
}

function stateForXhr(xhr: XMLHttpRequest): XhrState {
  const known = xhrStates.get(xhr);
  if (known) return known;
  const state: XhrState = { xhr, endings: [] };
  xhrStates.set(xhr, state);
  xhr.addEventListener("readystatechange", () => {
    const record = state.active;
    if (!record || xhr.readyState !== 4) return;
    captureXhrDone(state, record);
    if (record.cancelled) settleXhr(state, record, { kind: "cancelled" });
    else if (record.status !== 0) settleXhr(state, record, { kind: "response", status: record.status! });
  });
  xhr.addEventListener("load", () => endXhr(state, "response"));
  xhr.addEventListener("error", () => endXhr(state, "network-error"));
  xhr.addEventListener("timeout", () => endXhr(state, "timeout"));
  xhr.addEventListener("abort", () => endXhr(state, "cancelled"));
  return state;
}

function patchXhr(): void {
  underlyingXhrOpen = XMLHttpRequest.prototype.open;
  underlyingXhrSend = XMLHttpRequest.prototype.send;
  underlyingXhrAbort = XMLHttpRequest.prototype.abort;
  underlyingXhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: unknown[]) {
    const state = stateForXhr(this);
    const previousPrepared = state.prepared;
    const previousActive = state.active;
    const previousEndings = [...state.endings];
    const done = previousActive && this.readyState === 4;
    if (done) captureXhrDone(state, previousActive);
    state.active = undefined;
    state.prepared = { url: String(url), method: method.toUpperCase(), headers: new Map() };
    try {
      underlyingXhrOpen.call(this, method, url, ...(rest as [boolean, string?, string?]));
    } catch (error) {
      state.prepared = previousPrepared;
      state.active = previousActive;
      state.endings = previousEndings;
      trackXhr(state);
      throw error;
    }
    if (previousActive) {
      if (!done) {
        previousActive.cancelled = true;
        settleXhr(state, previousActive, { kind: "cancelled" });
      } else if (previousActive.status !== 0) {
        settleXhr(state, previousActive, { kind: "response", status: previousActive.status! });
      }
    }
    trackXhr(state);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name: string, value: string) {
    const result = underlyingXhrSetHeader.call(this, name, value);
    const prepared = xhrStates.get(this)?.prepared;
    if (prepared) {
      const key = String(name).toLowerCase();
      const normalized = String(value).trim();
      const previous = prepared.headers.get(key);
      prepared.headers.set(key, previous === undefined ? normalized : `${previous}, ${normalized}`);
    }
    return result;
  };

  XMLHttpRequest.prototype.abort = function () {
    const state = xhrStates.get(this);
    const active = state?.active;
    if (state && active) {
      if (this.readyState === 4) {
        captureXhrDone(state, active);
        if (active.status !== 0) settleXhr(state, active, { kind: "response", status: active.status! });
      } else {
        active.cancelled = true;
      }
    }
    return underlyingXhrAbort.call(this);
  };

  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const state = xhrStates.get(this);
    const prepared = state?.prepared;
    if (!state || !prepared) return underlyingXhrSend.call(this, body);
    const previousActive = state.active;
    const record: XhrRecord = { prepared, startTime: Date.now(), cancelled: false, completed: false };
    state.active = record;
    trackXhr(state);
    const headers = new Headers(Object.fromEntries(prepared.headers));
    const ctx: RequestContext = { url: prepared.url, method: prepared.method, headers };
    for (const listener of beforeListeners) {
      try { listener(ctx); } catch { /* swallow */ }
    }
    headers.forEach((value, key) => {
      if (prepared.headers.has(key)) return;
      try {
        underlyingXhrSetHeader.call(this, key, value);
        prepared.headers.set(key, value);
      } catch { /* rejected header */ }
    });
    // Adopt only the trace header that the platform accepted. Applied headers
    // survive a rejected send, so a retry adopts rather than appends them.
    if (!headers.has("traceparent") || headers.get("traceparent") === prepared.headers.get("traceparent")) {
      record.trace = ctx.trace;
    }
    try {
      return underlyingXhrSend.call(this, body);
    } catch (error) {
      if (state.active === record) state.active = previousActive;
      // A synchronous request can emit its terminal events before send throws.
      trackXhr(state);
      throw error;
    }
  };
}
