import { safeUrl, globMatch } from "./utils.js";

let targets: string[] = [];
let origFetch: typeof window.fetch | null = null;
let origXhrOpen: typeof XMLHttpRequest.prototype.open;
let origXhrSend: typeof XMLHttpRequest.prototype.send | null = null;

// Store trace IDs as a FIFO queue per URL so breadcrumbs can attach them.
// Concurrent same-URL fetches each record their own ID; consumers (the
// breadcrumb wrapper) read in the same order they were recorded.
const pendingTraceIds = new Map<string, string[]>();
const MAX_PENDING_TRACES = 200;

export function initTracing(tracePropagationTargets: string[]): void {
  targets = tracePropagationTargets;
  if (targets.length === 0) return;

  patchFetch();
  patchXhr();
}

/** Get and consume the trace ID generated for a request URL. FIFO per URL. */
export function consumeTraceId(url: string): string | undefined {
  const queue = pendingTraceIds.get(url);
  if (!queue || queue.length === 0) return undefined;
  const id = queue.shift();
  if (queue.length === 0) pendingTraceIds.delete(url);
  return id;
}

function shouldPropagate(url: string): boolean {
  const parsed = safeUrl(url);
  if (!parsed) return false;
  const hostPath = parsed.host + parsed.pathname;
  return targets.some((pattern) => globMatch(pattern, hostPath));
}

function generateTraceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function generateSpanId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function recordTrace(url: string): string {
  const traceId = generateTraceId();
  const queue = pendingTraceIds.get(url);
  if (queue) {
    queue.push(traceId);
  } else {
    pendingTraceIds.set(url, [traceId]);
  }
  // Bound total entries across all queues. Without this, requests whose
  // breadcrumb never lands (cross-origin fetch with opaque response, fire-
  // and-forget XHR) would accumulate indefinitely.
  let total = 0;
  for (const q of pendingTraceIds.values()) total += q.length;
  if (total > MAX_PENDING_TRACES) {
    const firstKey = pendingTraceIds.keys().next().value;
    if (firstKey !== undefined) {
      const q = pendingTraceIds.get(firstKey)!;
      q.shift();
      if (q.length === 0) pendingTraceIds.delete(firstKey);
    }
  }
  return traceId;
}

function patchFetch(): void {
  origFetch = window.fetch;
  const currentFetch = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    if (!shouldPropagate(url)) {
      return currentFetch.call(window, input, init);
    }

    const traceId = recordTrace(url);
    const spanId = generateSpanId();
    const traceparent = `00-${traceId}-${spanId}-01`;
    const headers = new Headers(init?.headers);
    headers.set("traceparent", traceparent);

    return currentFetch.call(window, input, { ...init, headers });
  };
}

function patchXhr(): void {
  origXhrOpen = XMLHttpRequest.prototype.open;
  origXhrSend = XMLHttpRequest.prototype.send;

  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    (this as XMLHttpRequest & { _traceUrl: string })._traceUrl =
      typeof url === "string" ? url : url.href;
    return origXhrOpen.call(this, method, url, ...(rest as [boolean, string?, string?]));
  };

  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const xhr = this as XMLHttpRequest & { _traceUrl: string };
    if (xhr._traceUrl && shouldPropagate(xhr._traceUrl)) {
      const traceId = recordTrace(xhr._traceUrl);
      const spanId = generateSpanId();
      const traceparent = `00-${traceId}-${spanId}-01`;
      xhr.setRequestHeader("traceparent", traceparent);
    }
    return origSend.call(this, body);
  };
}

export function destroyTracing(): void {
  if (origFetch) {
    window.fetch = origFetch;
    origFetch = null;
  }
  if (origXhrOpen) {
    XMLHttpRequest.prototype.open = origXhrOpen;
  }
  if (origXhrSend) {
    XMLHttpRequest.prototype.send = origXhrSend;
    origXhrSend = null;
  }
  targets = [];
  pendingTraceIds.clear();
}

