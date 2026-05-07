// Centralised fetch/XHR patch. Tracing and breadcrumbs both want to observe
// or modify network calls; without a shared hook each module patches
// window.fetch / XMLHttpRequest independently and the destroy chain has to
// unwind in the exact reverse of the patch order, otherwise window.fetch is
// left pointing at an orphaned wrapper. One patch with subscribers is the
// same pattern the navigation hook in breadcrumbs.ts already uses.

export interface RequestContext {
  url: string;
  method: string;
  /** Mutable headers. Before-listeners may add or replace entries; the
   * resulting Headers object is applied to the outgoing request. */
  headers: Headers;
}

export interface RequestResult {
  url: string;
  method: string;
  startTime: number;
  endTime: number;
  /** Request body, when it was a string. Form data and blobs are not
   * captured — listeners that want them must inspect init themselves. */
  requestBody?: string;
  /** Status code when a response was received. Missing on network error. */
  status?: number;
  /** True only for transport failures where no response was received
   * (thrown fetch, XHR error event). A non-2xx response is *not* an error
   * here — the request completed; the application code may treat the
   * status code however it wants. Listeners that want to flag 4xx/5xx
   * should inspect `status` themselves. */
  error: boolean;
  /** Set for fetch responses. Listeners must `.clone()` before reading. */
  response?: Response;
  /** Set for XHR responses. */
  xhr?: XMLHttpRequest;
}

export type BeforeRequestListener = (ctx: RequestContext) => void;
export type AfterRequestListener = (result: RequestResult) => void;

let beforeListeners: BeforeRequestListener[] = [];
let afterListeners: AfterRequestListener[] = [];

let installed = false;
let origFetch: typeof window.fetch;
let origXhrOpen: typeof XMLHttpRequest.prototype.open;
let origXhrSend: typeof XMLHttpRequest.prototype.send;

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
  window.fetch = origFetch;
  XMLHttpRequest.prototype.open = origXhrOpen;
  XMLHttpRequest.prototype.send = origXhrSend;
  beforeListeners = [];
  afterListeners = [];
  installed = false;
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
    const requestBody =
      init?.body && typeof init.body === "string" ? init.body : undefined;
    const headers = new Headers(init?.headers);

    const ctx: RequestContext = { url, method, headers };
    for (const l of beforeListeners) {
      try { l(ctx); } catch { /* never let one listener break the chain */ }
    }

    try {
      const response = await origFetch(input, { ...init, headers: ctx.headers });
      const result: RequestResult = {
        url,
        method,
        requestBody,
        startTime,
        endTime: Date.now(),
        status: response.status,
        error: false,
        response,
      };
      for (const l of afterListeners) {
        try { l(result); } catch { /* swallow */ }
      }
      return response;
    } catch (err) {
      const result: RequestResult = {
        url,
        method,
        requestBody,
        startTime,
        endTime: Date.now(),
        error: true,
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
};

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
    return origXhrOpen.call(
      this,
      method,
      url,
      ...(rest as [boolean, string?, string?]),
    );
  };

  XMLHttpRequest.prototype.send = function (
    body?: Document | XMLHttpRequestBodyInit | null,
  ) {
    const xhr = this as TaggedXhr;
    const url = xhr._ahUrl || "";
    const method = (xhr._ahMethod || "GET").toUpperCase();
    const startTime = Date.now();
    const requestBody = body && typeof body === "string" ? body : undefined;
    const headers = new Headers();

    const ctx: RequestContext = { url, method, headers };
    for (const l of beforeListeners) {
      try { l(ctx); } catch { /* swallow */ }
    }

    // Apply headers contributed by before-listeners. setRequestHeader can
    // throw on forbidden headers (Cookie, Host, etc.); ignore those.
    headers.forEach((value, key) => {
      try { xhr.setRequestHeader(key, value); } catch { /* forbidden header */ }
    });

    xhr.addEventListener("load", () => {
      const result: RequestResult = {
        url,
        method,
        requestBody,
        startTime,
        endTime: Date.now(),
        status: xhr.status,
        error: false,
        xhr,
      };
      for (const l of afterListeners) {
        try { l(result); } catch { /* swallow */ }
      }
    });

    xhr.addEventListener("error", () => {
      const result: RequestResult = {
        url,
        method,
        requestBody,
        startTime,
        endTime: Date.now(),
        error: true,
        xhr,
      };
      for (const l of afterListeners) {
        try { l(result); } catch { /* swallow */ }
      }
    });

    return origXhrSend.call(this, body);
  };
}
