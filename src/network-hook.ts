// Centralised fetch/XHR patch. Tracing and breadcrumbs both want to observe
// or modify network calls; without a shared hook each module patches
// window.fetch / XMLHttpRequest independently and the destroy chain has to
// unwind in the exact reverse of the patch order, otherwise window.fetch is
// left pointing at an orphaned wrapper. One patch with subscribers is the
// same pattern the navigation hook in breadcrumbs.ts already uses.

import { attemptCleanup } from "./utils.js";

/** The identity a before-listener propagated for one request. Carried to the
 * result rather than read back at completion: read back, it would give the
 * identity current *then*, which after a new interaction is the wrong one. */
export interface RequestTrace {
  trace_id: string;
}

export interface RequestContext {
  url: string;
  method: string;
  /** Mutable headers. Before-listeners may add or replace entries; the
   * resulting Headers object is applied to the outgoing request. */
  headers: Headers;
  /** Set by the tracing listener when it propagates a `traceparent`. */
  trace?: RequestTrace;
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
  /** The host cancelled it. Still reported, so a listener can release the
   * trace id, but `error` stays false. */
  aborted?: boolean;
  /** Set for fetch responses. Listeners must `.clone()` before reading. */
  response?: Response;
  /** Set for XHR responses. */
  xhr?: XMLHttpRequest;
  /** What the before-listeners propagated, if anything. */
  trace?: RequestTrace;
}

export type BeforeRequestListener = (ctx: RequestContext) => void;
export type AfterRequestListener = (result: RequestResult) => void;

let beforeListeners: BeforeRequestListener[] = [];
let afterListeners: AfterRequestListener[] = [];

let installed = false;
let origFetch: typeof window.fetch;
let origXhrOpen: typeof XMLHttpRequest.prototype.open;
let origXhrSend: typeof XMLHttpRequest.prototype.send;
let origXhrAbort: typeof XMLHttpRequest.prototype.abort;

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
  let restored = true;
  if (origFetch) {
    restored = attemptCleanup("fetch patch", () => { window.fetch = origFetch; }) && restored;
  }
  if (origXhrOpen) {
    restored = attemptCleanup("xhr open patch", () => { XMLHttpRequest.prototype.open = origXhrOpen; }) && restored;
  }
  if (origXhrSend) {
    restored = attemptCleanup("xhr send patch", () => { XMLHttpRequest.prototype.send = origXhrSend; }) && restored;
  }
  if (origXhrAbort) {
    restored = attemptCleanup("xhr abort patch", () => { XMLHttpRequest.prototype.abort = origXhrAbort; }) && restored;
  }
  installed = !restored;
}

function patchFetch(): void {
  origFetch = window.fetch.bind(window);
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

    // Default path: no before-listeners (tracing is the only one, and only
    // when tracePropagationTargets is configured). Pass `init` straight
    // through so headers carried on a `Request` input — Authorization,
    // Content-Type, custom — survive. Rebuilding init with a fresh
    // `new Headers(init?.headers)` would be empty for a `fetch(request)` call
    // and silently drop every header the caller set on the Request.
    let finalInit = init;
    let trace: RequestTrace | undefined;
    if (beforeListeners.length > 0) {
      // Seed from the *effective* request headers (Request headers first,
      // then init headers override — the platform's own precedence) so a
      // listener that adds a header doesn't clobber the caller's.
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      if (init?.headers) new Headers(init.headers).forEach((v, k) => headers.set(k, v));

      const ctx: RequestContext = { url, method, headers };
      for (const l of beforeListeners) {
        try { l(ctx); } catch { /* never let one listener break the chain */ }
      }
      trace = ctx.trace;
      finalInit = { ...init, headers };
    }

    try {
      const response = await origFetch(input, finalInit);
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
      for (const l of afterListeners) {
        try { l(result); } catch { /* swallow */ }
      }
      return response;
    } catch (err) {
      // A cancelled fetch rejects with AbortError, which is not a failure.
      const aborted = (err as { name?: string } | null)?.name === "AbortError";
      const result: RequestResult = {
        url,
        method,
        startTime,
        endTime: Date.now(),
        error: !aborted,
        aborted,
        trace,
      };
      for (const l of afterListeners) {
        try { l(result); } catch { /* swallow */ }
      }
      throw err;
    }
  };
}

type TaggedXhr = XMLHttpRequest & {
  _ahMethod?: string;
  _ahUrl?: string;
  _ahHooked?: boolean;
  // The request that send() started. The listeners take this record, so a host
  // that opens the object again for the next request cannot change the report
  // of the request that is still in flight.
  _ahPending?: {
    url: string;
    method: string;
    startTime: number;
    aborted?: boolean;
    trace?: RequestTrace;
  } | null;
};

/** Registers once per object, in open(): listeners run in registration order
 * and a host attaches between open() and send(). A host that attaches before
 * open() still wins; closing that would need a constructor patch. */
function hookXhr(tagged: TaggedXhr): void {
  if (tagged._ahHooked) return;
  tagged._ahHooked = true;

  const emit = (error: boolean) => {
    const pending = tagged._ahPending;
    if (!pending) return;
    // One report per send(), whichever event arrives first.
    tagged._ahPending = null;
    const aborted = pending.aborted === true;
    const result: RequestResult = {
      url: pending.url,
      method: pending.method,
      startTime: pending.startTime,
      endTime: Date.now(),
      error: error && !aborted,
      aborted,
      xhr: tagged,
      trace: pending.trace,
    };
    if (!error) result.status = tagged.status;
    for (const l of afterListeners) {
      try { l(result); } catch { /* swallow */ }
    }
  };

  tagged.addEventListener("readystatechange", () => {
    if (tagged.readyState !== 4) return;
    // status 0 at DONE is a transport failure. abort() marks the record first,
    // so emit reports a cancel instead.
    emit(tagged.status === 0);
  });
  tagged.addEventListener("load", () => emit(false));
  tagged.addEventListener("error", () => emit(true));
}

function patchXhr(): void {
  origXhrOpen = XMLHttpRequest.prototype.open;
  origXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    const tagged = this as TaggedXhr;
    tagged._ahMethod = method;
    tagged._ahUrl = typeof url === "string" ? url : url.href;
    hookXhr(tagged);
    return origXhrOpen.call(
      this,
      method,
      url,
      ...(rest as [boolean, string?, string?]),
    );
  };

  // abort() reaches readyState 4 with status 0, indistinguishable from a
  // failure, and fires before the `abort` event. Mark it here.
  origXhrAbort = XMLHttpRequest.prototype.abort;
  XMLHttpRequest.prototype.abort = function () {
    const tagged = this as TaggedXhr;
    if (tagged._ahPending) tagged._ahPending.aborted = true;
    return origXhrAbort.call(this);
  };

  XMLHttpRequest.prototype.send = function (
    body?: Document | XMLHttpRequestBodyInit | null,
  ) {
    const xhr = this as TaggedXhr;
    const url = xhr._ahUrl || "";
    const method = (xhr._ahMethod || "GET").toUpperCase();
    // Opened before the SDK patched open(), so there is no url to report or
    // propagate to.
    if (!url) return origXhrSend.call(this, body);

    hookXhr(xhr);
    xhr._ahPending = { url, method, startTime: Date.now() };
    const headers = new Headers();

    const ctx: RequestContext = { url, method, headers };
    for (const l of beforeListeners) {
      try { l(ctx); } catch { /* swallow */ }
    }
    if (xhr._ahPending) xhr._ahPending.trace = ctx.trace;

    // Apply headers contributed by before-listeners. setRequestHeader can
    // throw on forbidden headers (Cookie, Host, etc.); ignore those.
    headers.forEach((value, key) => {
      try { xhr.setRequestHeader(key, value); } catch { /* forbidden header */ }
    });

    return origXhrSend.call(this, body);
  };
}
