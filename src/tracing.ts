import { safeUrl, globMatch } from "./utils.js";
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

export function initTracing(tracePropagationTargets: string[]): void {
  targets = tracePropagationTargets;
  if (targets.length === 0) return;

  unregister = onBeforeRequest((ctx) => {
    if (!shouldPropagate(ctx.url)) return;
    const traceId = randomHex(16);
    const spanId = randomHex(8);
    pendingTraces.push(ctx.url, traceId);
    ctx.headers.set("traceparent", `00-${traceId}-${spanId}-01`);
  });
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
  const bytes = new Uint8Array(numBytes);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
