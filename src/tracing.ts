import { safeUrl, globMatch, randomBytes, toHex, timeOrigin } from "./utils.js";
import { onBeforeRequest } from "./network-hook.js";

const TRACE_ID_BYTES = 16;
const SPAN_ID_BYTES = 8;
// Navigations kept after they end, so an error can still name the root of a
// trace whose requests are still in the breadcrumb buffer.
const RECENT_NAVIGATIONS = 5;

/** The root of one navigation's trace. Every request the page makes hangs off
 * it, so the backend spans have a parent that exists and the trace says which
 * page asked for them. */
export interface Navigation {
  trace_id: string;
  span_id: string;
  /** The route, templated when the host declared one. */
  action: string;
  start_time: number;
}

let targets: string[] = [];
// Names the route. Passed in rather than read from the vitals module, so this
// module keeps no opinion about where a route lives.
let resolveRoute: (() => string) | null = null;
let unregister: (() => void) | null = null;

let traceId: string | null = null;
let spanId: string | null = null;
let startTime = 0;
let recent: Navigation[] = [];

export function initTracing(
  tracePropagationTargets: string[],
  routeName?: () => string,
): void {
  targets = tracePropagationTargets;
  resolveRoute = routeName ?? null;
  startTime = timeOrigin();
  if (targets.length === 0) return;

  unregister = onBeforeRequest((ctx) => {
    if (!shouldPropagate(ctx.url)) return;

    // Minted on the first request that propagates, not at navigation start.
    // Nothing refers to the span before that, and by now the host's router has
    // usually declared its route, so the span can carry one.
    if (traceId === null || spanId === null) {
      traceId = randomHex(TRACE_ID_BYTES);
      spanId = randomHex(SPAN_ID_BYTES);
      remember({
        trace_id: traceId,
        span_id: spanId,
        action: resolveRoute ? resolveRoute() : "",
        start_time: startTime,
      });
    }

    // The navigation span parents every request of the page, so each backend
    // span has a parent that exists and the page reads as one trace.
    ctx.headers.set("traceparent", `00-${traceId}-${spanId}-01`);
    ctx.trace = { trace_id: traceId };
  });
}

/** Start the next navigation's trace. A route change ends the page the trace
 * describes, and a single-page app would otherwise build one trace that never
 * ends. */
export function markTracingNavigation(): void {
  traceId = null;
  spanId = null;
  startTime = Date.now();
}

/** The navigation a trace belongs to, current or recent. */
export function getNavigation(forTraceId: string): Navigation | undefined {
  return recent.find((navigation) => navigation.trace_id === forTraceId);
}

export function destroyTracing(): void {
  if (unregister) {
    unregister();
    unregister = null;
  }
  targets = [];
  resolveRoute = null;
  traceId = null;
  spanId = null;
  startTime = 0;
  recent = [];
}

function remember(navigation: Navigation): void {
  recent = [navigation, ...recent].slice(0, RECENT_NAVIGATIONS);
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
