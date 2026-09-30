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
  /** The request ran out of time. A subset of `error`: the server received it
   * and may well have traced it, unlike a refused or undeliverable request. */
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
const xhrsToReport = new Set<WatchedXhr>();

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
    let trace: PropagatedTrace | undefined;

    // Default path: no before-listeners (tracing is the only one, and only
    // when tracePropagationTargets is configured). Pass `init` straight
    // through so headers carried on a `Request` input — Authorization,
    // Content-Type, custom — survive. Rebuilding init with a fresh
    // `new Headers(init?.headers)` would be empty for a `fetch(request)` call
    // and silently drop every header the caller set on the Request.
    let finalInit = init;
    if (beforeListeners.length > 0) {
      // Seed from the *effective* request headers (Request headers first,
      // then init headers override — the platform's own precedence) so a
      // listener that adds a header doesn't clobber the caller's.
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      if (init?.headers) new Headers(init.headers).forEach((v, k) => headers.set(k, v));

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
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const name = (err as { name?: string } | null)?.name;
      // Custom abort reasons still mean cancellation. TimeoutError is a
      // failed request, including AbortSignal.timeout().
      const aborted = name === "AbortError" || (signal?.aborted === true && name !== "TimeoutError");
      const result: RequestResult = {
        url,
        method,
        startTime,
        endTime: Date.now(),
        error: !aborted,
        timedOut: name === "TimeoutError",
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

type WatchedXhr = XMLHttpRequest & {
  _appsignalMethod?: string;
  _appsignalUrl?: string;
  _appsignalWatched?: boolean;
  // The request that send() started. The listeners take this record, so a host
  // that opens the object again for the next request cannot change the report
  // of the request that is still in flight.
  _appsignalRequest?: {
    url: string;
    method: string;
    startTime: number;
    aborted?: boolean;
    trace?: PropagatedTrace;
  } | null;
};

function reportXhr(xhr: WatchedXhr, failed: boolean): void {
  const pending = xhr._appsignalRequest;
  if (!pending) return;
  // One report per send(), whichever event arrives first.
  xhr._appsignalRequest = null;
  xhrsToReport.delete(xhr);
  const aborted = pending.aborted === true;
  const endTime = Date.now();
  // The `timeout` event arrives after readystatechange reaches DONE, too late
  // for this report. A failure at or past the deadline is that timeout;
  // startTime is taken before the native send, so elapsed never reads short.
  const timedOut = failed && !aborted && xhr.timeout > 0 && endTime - pending.startTime >= xhr.timeout;
  const result: RequestResult = {
    url: pending.url,
    method: pending.method,
    startTime: pending.startTime,
    endTime,
    error: failed && !aborted,
    timedOut,
    aborted,
    xhr,
    trace: pending.trace,
  };
  if (!failed) result.status = xhr.status;
  for (const listener of afterListeners) {
    try { listener(result); } catch { /* swallow */ }
  }
}

/** Report each XHR that has finished but whose report has not run yet. A host
 * handler that was set before open() runs before the SDK's listeners, so code
 * in it that needs to know the request it is handling calls this first. */
export function reportFinishedXhrs(): void {
  for (const xhr of xhrsToReport) {
    // status 0 at DONE is a transport failure, as in the readystatechange listener.
    if (xhr.readyState === 4) reportXhr(xhr, xhr.status === 0);
  }
}

/** Registers once per object, in open(): listeners run in registration order
 * and a host attaches between open() and send(). A host that attaches before
 * open() still wins, and reportFinishedXhrs covers that case. */
function watchXhr(xhr: WatchedXhr): void {
  if (xhr._appsignalWatched) return;
  xhr._appsignalWatched = true;

  xhr.addEventListener("readystatechange", () => {
    if (xhr.readyState !== 4) return;
    // status 0 at DONE is a transport failure. abort() marks the record first,
    // so reportXhr reports a cancel instead.
    reportXhr(xhr, xhr.status === 0);
  });
  // Only at DONE: a host that sends the next request from its own load or
  // error handler has already moved the object on to that request.
  xhr.addEventListener("load", () => {
    if (xhr.readyState === 4) reportXhr(xhr, false);
  });
  xhr.addEventListener("error", () => {
    if (xhr.readyState === 4) reportXhr(xhr, true);
  });
}

function patchXhr(): void {
  underlyingXhrOpen = XMLHttpRequest.prototype.open;
  underlyingXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    const xhr = this as WatchedXhr;
    xhr._appsignalMethod = method;
    xhr._appsignalUrl = typeof url === "string" ? url : url.href;
    watchXhr(xhr);
    return underlyingXhrOpen.call(
      this,
      method,
      url,
      ...(rest as [boolean, string?, string?]),
    );
  };

  // abort() reaches readyState 4 with status 0, indistinguishable from a
  // failure, and fires before the `abort` event. Mark it here.
  underlyingXhrAbort = XMLHttpRequest.prototype.abort;
  XMLHttpRequest.prototype.abort = function () {
    const xhr = this as WatchedXhr;
    if (xhr._appsignalRequest) xhr._appsignalRequest.aborted = true;
    return underlyingXhrAbort.call(this);
  };

  XMLHttpRequest.prototype.send = function (
    body?: Document | XMLHttpRequestBodyInit | null,
  ) {
    const xhr = this as WatchedXhr;
    const url = xhr._appsignalUrl || "";
    const method = (xhr._appsignalMethod || "GET").toUpperCase();
    // Opened before the SDK patched open(), so there is no url to report or
    // propagate to.
    if (!url) return underlyingXhrSend.call(this, body);

    watchXhr(xhr);
    const previous = xhr._appsignalRequest;
    const pending: NonNullable<WatchedXhr["_appsignalRequest"]> = { url, method, startTime: Date.now() };
    xhr._appsignalRequest = pending;
    xhrsToReport.add(xhr);
    const headers = new Headers();

    const ctx: RequestContext = { url, method, headers };
    for (const listener of beforeListeners) {
      try { listener(ctx); } catch { /* swallow */ }
    }
    pending.trace = ctx.trace;

    // Apply headers contributed by before-listeners. setRequestHeader can
    // throw on forbidden headers (Cookie, Host, etc.); ignore those.
    headers.forEach((value, key) => {
      try { xhr.setRequestHeader(key, value); } catch { /* forbidden header */ }
    });

    try {
      return underlyingXhrSend.call(this, body);
    } catch (error) {
      // The native send refused this call, so the request already in flight,
      // if there is one, keeps its own record.
      xhr._appsignalRequest = previous;
      if (!previous) xhrsToReport.delete(xhr);
      throw error;
    }
  };
}
