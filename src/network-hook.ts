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
    if (beforeListeners.length > 0) {
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

/** One request on one XMLHttpRequest, from send() to its report.
 *
 * `status` is captured when the request reaches DONE rather than read from the
 * object at report time. The event that classifies a transport failure arrives
 * after DONE, and a host can reuse the object in between, so by then the
 * object's own status belongs to another request. */
type XhrRecord = {
  url: string;
  method: string;
  startTime: number;
  aborted: boolean;
  status?: number;
  trace?: PropagatedTrace;
};

type WatchedXhr = XMLHttpRequest & {
  _appsignalMethod?: string;
  _appsignalUrl?: string;
  _appsignalWatched?: boolean;
  // Headers the host set on this request, keyed by lowercased name.
  // setRequestHeader combines values rather than replacing them, so the SDK
  // has to know which names to leave alone, and a before-listener needs the
  // value to read a traceparent the host already set. XHR cannot read a
  // request header back.
  _appsignalHostHeaders?: Map<string, string>;
  // The send() that is still running.
  _appsignalSending?: XhrRecord | null;
  // A request that reached DONE with no status, waiting for the named event
  // that says which failure it was. Held apart from `_appsignalSending`,
  // because a host can retry on this object before that event arrives.
  _appsignalParked?: XhrRecord | null;
};

/** The record the event now firing belongs to, removed from the object so it
 * reports once.
 *
 * Every listener takes its record from here. A parked record wins, because the
 * event that classifies it arrives after the object may have moved on. Reading
 * the two slots in a different order in one listener than in another is what
 * made a parked record emit against the next request's status. */
function takeXhrRecord(xhr: WatchedXhr): XhrRecord | null {
  const parked = xhr._appsignalParked;
  if (parked) {
    xhr._appsignalParked = null;
    if (!xhr._appsignalSending) xhrsToReport.delete(xhr);
    return parked;
  }
  // No handoff happened, so a host handler that beat ours still owns the
  // object. Its own request is the one this event belongs to.
  const sending = xhr._appsignalSending;
  if (sending && xhr.readyState === 4) {
    xhr._appsignalSending = null;
    xhrsToReport.delete(xhr);
    return sending;
  }
  return null;
}

function emitXhrReport(
  xhr: WatchedXhr,
  record: XhrRecord,
  failed: boolean,
  timedOut: boolean,
): void {
  const aborted = record.aborted;
  const result: RequestResult = {
    url: record.url,
    method: record.method,
    startTime: record.startTime,
    endTime: Date.now(),
    error: failed && !aborted,
    timedOut: timedOut && !aborted,
    aborted,
    xhr,
    trace: record.trace,
  };
  if (!failed) result.status = record.status;
  for (const listener of afterListeners) {
    try { listener(result); } catch { /* swallow */ }
  }
}

/** Report whatever this event ended. One release point, so no two listeners
 * can disagree about which record an event belongs to. */
function releaseXhr(xhr: WatchedXhr, failed: boolean, timedOut = false): void {
  const record = takeXhrRecord(xhr);
  if (record) emitXhrReport(xhr, record, failed, timedOut);
}

/** Report each XHR that has finished but whose report has not run yet. A host
 * handler that was set before the SDK's listeners runs first, so code in it
 * that needs to know the request it is handling calls this first. */
export function reportFinishedXhrs(): void {
  for (const xhr of xhrsToReport) {
    // No named event has run for these, so a transport failure stays
    // unclassified and reports as a plain failure, never as a timeout.
    if (xhr._appsignalParked || xhr.readyState === 4) {
      releaseXhr(xhr, (xhr._appsignalParked?.status ?? xhr.status) === 0);
    }
  }
}

/** Report a request the reopen is about to terminate. `open()` resets the
 * object and the events that would have reported it never fire, so a host that
 * retries on it would otherwise lose the request it is retrying. A parked
 * record is left alone: its named event still has to classify it, and
 * reporting it here would drop the timeout. */
function flushOnReopen(xhr: WatchedXhr): void {
  const sending = xhr._appsignalSending;
  if (!sending) return;
  if (xhr.readyState === 4) {
    sending.status = xhr.status;
    releaseXhr(xhr, xhr.status === 0);
    return;
  }
  sending.aborted = true;
  releaseXhr(xhr, true);
}

/** Registers once per object, in open(): listeners run in registration order
 * and a host attaches between open() and send(). A host that attaches before
 * open() still wins, and reportFinishedXhrs covers that case. */
function watchXhr(xhr: WatchedXhr): void {
  if (xhr._appsignalWatched) return;
  xhr._appsignalWatched = true;

  xhr.addEventListener("readystatechange", () => {
    if (xhr.readyState !== 4) return;
    const sending = xhr._appsignalSending;
    if (!sending) return;
    // Capture it now. The named event that classifies a status 0 arrives
    // later, and the object may belong to another request by then.
    sending.status = xhr.status;
    if (xhr.status === 0) {
      // Only the named event that follows says which failure this was.
      // Elapsed time cannot stand in for it: a blocked main thread delivers a
      // connection failure after the deadline and makes it look like a timeout.
      xhr._appsignalSending = null;
      xhr._appsignalParked = sending;
      return;
    }
    releaseXhr(xhr, false);
  });

  // `load` after a status 0 means the request succeeded and no named event is
  // coming, as a `file:` URL does.
  xhr.addEventListener("load", () => releaseXhr(xhr, false));
  xhr.addEventListener("error", () => releaseXhr(xhr, true));
  xhr.addEventListener("timeout", () => releaseXhr(xhr, true, true));
  // abort() marks the record, so this reports a cancel. Without it a cancelled
  // request reaches no listener at all, because readystatechange leaves every
  // status 0 to the named event.
  xhr.addEventListener("abort", () => releaseXhr(xhr, true));
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
    flushOnReopen(xhr);
    // open() clears the request's headers, so the record of them goes too.
    xhr._appsignalHostHeaders = undefined;
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
  underlyingXhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name: string, value: string) {
    const xhr = this as WatchedXhr;
    const result = underlyingXhrSetHeader.call(this, name, value);
    // Recorded only once the call is accepted: a rejected one leaves no header
    // on the request, so the SDK must still apply its own.
    (xhr._appsignalHostHeaders ??= new Map()).set(String(name).toLowerCase(), String(value));
    return result;
  };

  underlyingXhrAbort = XMLHttpRequest.prototype.abort;
  XMLHttpRequest.prototype.abort = function () {
    const xhr = this as WatchedXhr;
    const live = xhr._appsignalSending ?? xhr._appsignalParked;
    if (live) live.aborted = true;
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
    const previous = xhr._appsignalSending;
    const pending: XhrRecord = { url, method, startTime: Date.now(), aborted: false };
    xhr._appsignalSending = pending;
    xhrsToReport.add(xhr);
    const headers = new Headers();
    // Show a before-listener the trace header the host already set, so it can
    // join that trace instead of starting a rival one.
    const hostTraceparent = xhr._appsignalHostHeaders?.get("traceparent");
    if (hostTraceparent) headers.set("traceparent", hostTraceparent);

    const ctx: RequestContext = { url, method, headers };
    for (const listener of beforeListeners) {
      try { listener(ctx); } catch { /* swallow */ }
    }
    pending.trace = ctx.trace;

    // Apply headers contributed by before-listeners, through the underlying
    // method so they are not recorded as the host's. A name the host already
    // set is left alone: setRequestHeader would append to it and produce one
    // malformed header rather than replacing it. setRequestHeader can also
    // throw on forbidden headers (Cookie, Host, etc.); ignore those.
    const hostHeaders = xhr._appsignalHostHeaders;
    headers.forEach((value, key) => {
      if (hostHeaders?.has(key.toLowerCase())) return;

      try { underlyingXhrSetHeader.call(xhr, key, value); } catch { /* forbidden header */ }
    });

    try {
      return underlyingXhrSend.call(this, body);
    } catch (error) {
      // The native send refused this call, so the request already in flight,
      // if there is one, keeps its own record.
      xhr._appsignalSending = previous ?? null;
      if (!previous && !xhr._appsignalParked) xhrsToReport.delete(xhr);
      throw error;
    }
  };
}
