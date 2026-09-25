import { safeUrl, globMatch, randomBytes, toHex } from "./utils.js";
import { onBeforeRequest } from "./network-hook.js";

let targets: string[] = [];
let unregister: (() => void) | null = null;

// FIFO queue keyed by URL, with a global cap on total entries. Concurrent
// same-URL fetches each push their own trace_id; the breadcrumb wrapper
// shifts them in the order they were recorded. The global cap bounds memory
// when a request's breadcrumb never lands (cross-origin opaque responses,
// fire-and-forget XHR, etc.).
class KeyedQueue<V> {
  private readonly buckets = new Map<string, V[]>();
  private total = 0;

  constructor(private readonly maxTotal: number) {}

  push(key: string, value: V): void {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = [];
      this.buckets.set(key, bucket);
    }
    bucket.push(value);
    this.total++;
    if (this.total > this.maxTotal) this.evictOldest();
  }

  shift(key: string): V | undefined {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.length === 0) return undefined;
    const value = bucket.shift();
    this.total--;
    if (bucket.length === 0) this.buckets.delete(key);
    return value;
  }

  clear(): void {
    this.buckets.clear();
    this.total = 0;
  }

  private evictOldest(): void {
    // Map iteration order is insertion order; the first key is the oldest
    // bucket, and shift() drops the oldest entry within it.
    const oldestKey = this.buckets.keys().next().value;
    if (oldestKey === undefined) return;
    this.shift(oldestKey);
  }
}

const pendingTraces = new KeyedQueue<string>(200);

// The identity of the last request that carried a traceparent. A traceparent
// promises a span with that ID exists, and nothing in the browser sends one, so
// an error that follows the request takes the ID as its own and the promise
// comes true. The error then holds the place the backend spans of that request
// point at.
let lastPropagated: { traceId: string; spanId: string; startTime: number; claimed: boolean } | null = null;

// An error much later than the request has nothing to do with it. Ten seconds
// covers a response the host is still rendering, and little else.
const MAX_ERROR_DELAY_MS = 10_000;

export interface ErrorTrace {
  trace_id: string;
  /** Set on the error that takes the request's promised span. */
  span_id?: string;
  /** Set on a second error after the same request, which hangs off the first. */
  parent_span_id?: string;
  /** Unix seconds. The request's start, so the span covers the request it
   * claims rather than the instant the error happened. */
  start_time?: number;
}

export function initTracing(tracePropagationTargets: string[]): void {
  targets = tracePropagationTargets;
  if (targets.length === 0) return;

  unregister = onBeforeRequest((ctx) => {
    if (!shouldPropagate(ctx.url)) return;
    const traceId = randomHex(16);
    const spanId = randomHex(8);
    pendingTraces.push(ctx.url, traceId);
    ctx.headers.set("traceparent", `00-${traceId}-${spanId}-01`);
    lastPropagated = { traceId, spanId, startTime: Date.now(), claimed: false };
  });
}

/** Trace identity for an error that is about to ship, or undefined when no
 * recent request propagated one. The error joins the trace of the request it
 * followed, which is a guess: the request whose response the host was handling
 * is usually the last one, and with several in flight it is the last to start.
 * A second error after the same request hangs off the first. */
export function claimErrorTrace(): ErrorTrace | undefined {
  if (!lastPropagated) return undefined;
  if (Date.now() - lastPropagated.startTime > MAX_ERROR_DELAY_MS) return undefined;

  const { traceId, spanId, startTime, claimed } = lastPropagated;
  if (claimed) return { trace_id: traceId, parent_span_id: spanId };

  lastPropagated.claimed = true;
  return {
    trace_id: traceId,
    span_id: spanId,
    // Unix seconds, like the transaction's own timestamp.
    start_time: Math.floor(startTime / 1000),
  };
}

/** Get and consume the trace ID generated for a request URL. FIFO per URL. */
export function consumeTraceId(url: string): string | undefined {
  return pendingTraces.shift(url);
}

export function destroyTracing(): void {
  if (unregister) {
    unregister();
    unregister = null;
  }
  targets = [];
  pendingTraces.clear();
  lastPropagated = null;
}

function shouldPropagate(url: string): boolean {
  const parsed = safeUrl(url);
  if (!parsed) return false;
  const hostPath = parsed.host + parsed.pathname;
  return targets.some((pattern) => globMatch(pattern, hostPath));
}

/** N random bytes encoded as a lowercase hex string. Used for both the
 * 128-bit trace_id and the 64-bit span_id of the W3C traceparent header. */
function randomHex(numBytes: number): string {
  return toHex(randomBytes(numBytes));
}
