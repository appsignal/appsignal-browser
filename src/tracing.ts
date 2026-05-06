import { safeUrl, globMatch } from "./utils.js";
import { onBeforeRequest } from "./network-hook.js";

let targets: string[] = [];
let unregister: (() => void) | null = null;

// Store trace IDs as a FIFO queue per URL so breadcrumbs can attach them.
// Concurrent same-URL fetches each record their own ID; consumers (the
// breadcrumb wrapper) read in the same order they were recorded.
const pendingTraceIds = new Map<string, string[]>();
const MAX_PENDING_TRACES = 200;

export function initTracing(tracePropagationTargets: string[]): void {
  targets = tracePropagationTargets;
  if (targets.length === 0) return;

  unregister = onBeforeRequest((ctx) => {
    if (!shouldPropagate(ctx.url)) return;
    const traceId = recordTrace(ctx.url);
    const spanId = generateSpanId();
    ctx.headers.set("traceparent", `00-${traceId}-${spanId}-01`);
  });
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

export function destroyTracing(): void {
  if (unregister) {
    unregister();
    unregister = null;
  }
  targets = [];
  pendingTraceIds.clear();
}
