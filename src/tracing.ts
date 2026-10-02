import { safeUrl, matchesUrl, randomBytes, toHex } from "./utils.js";
import { onBeforeRequest, type PropagatedTrace, type RequestResult } from "./network-hook.js";

let targets: string[] = [];
let unregisters: (() => void)[] = [];

export function initTracing(tracePropagationTargets: string[]): void {
  destroyTracing();
  targets = tracePropagationTargets;
  if (targets.length === 0) return;

  unregisters.push(onBeforeRequest((ctx) => {
    if (!shouldPropagate(ctx.url)) return;
    const caller = parseTraceparent(ctx.headers.get("traceparent"));
    if (caller) {
      // The caller propagates its own context. Join that trace rather than
      // start a rival one, and report the ids that actually go on the wire.
      ctx.trace = caller;
      return;
    }
    const traceId = randomHex(16);
    const spanId = randomHex(8);
    ctx.headers.set("traceparent", `00-${traceId}-${spanId}-01`);
    // Kept on the request itself, so whatever reads it later gets the ids of
    // that request and not of another one to the same URL.
    ctx.trace = { traceId, spanId };
  }));
}

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;

/** The ids of a W3C `traceparent` the caller set, when it is one we can join.
 * An all-zero id is invalid per the spec and names no span. */
function parseTraceparent(value: string | null): PropagatedTrace | undefined {
  if (!value) return undefined;
  const [version, traceId, spanId] = value.trim().split("-");
  if (version?.length !== 2) return undefined;
  if (!TRACE_ID.test(traceId ?? "") || !SPAN_ID.test(spanId ?? "")) return undefined;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined;
  return { traceId, spanId };
}

/** The trace ID a request propagated, or undefined when it propagated none.
 * It comes from the request itself, so two requests to one URL that answer in
 * either order each report their own. */
export function traceIdForRequest(result: RequestResult): string | undefined {
  return result.trace?.traceId;
}

export function destroyTracing(): void {
  for (const unregister of unregisters) unregister();
  unregisters = [];
  targets = [];
}

function shouldPropagate(url: string): boolean {
  const parsed = safeUrl(url);
  if (!parsed) return false;
  return targets.some((pattern) => matchesUrl(pattern, parsed));
}

/** N random bytes encoded as a lowercase hex string. Used for both the
 * 128-bit trace_id and the 64-bit span_id of the W3C traceparent header. */
function randomHex(numBytes: number): string {
  return toHex(randomBytes(numBytes));
}
