import { safeUrl, globMatch, randomBytes, toHex } from "./utils.js";
import { onBeforeRequest, type RequestResult } from "./network-hook.js";

let targets: string[] = [];
let unregister: (() => void) | null = null;

/** The ids a request put in its `traceparent` header. They are kept on the
 * request itself, so whatever reads them later gets the ids of that request
 * and not of another one to the same URL. */
interface PropagatedRequest {
  traceId: string;
  spanId: string;
}

const REQUEST_KEY = "appsignal.propagated";

export function initTracing(tracePropagationTargets: string[]): void {
  targets = tracePropagationTargets;
  if (targets.length === 0) return;

  unregister = onBeforeRequest((ctx) => {
    if (!shouldPropagate(ctx.url)) return;
    const traceId = randomHex(16);
    const spanId = randomHex(8);
    ctx.headers.set("traceparent", `00-${traceId}-${spanId}-01`);
    const request: PropagatedRequest = { traceId, spanId };
    ctx.data[REQUEST_KEY] = request;
  });
}

/** The trace ID a request propagated, or undefined when it propagated none.
 * It comes from the request itself, so two requests to one URL that answer in
 * either order each report their own. */
export function traceIdForRequest(result: RequestResult): string | undefined {
  return (result.data[REQUEST_KEY] as PropagatedRequest | undefined)?.traceId;
}

export function destroyTracing(): void {
  if (unregister) {
    unregister();
    unregister = null;
  }
  targets = [];
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
