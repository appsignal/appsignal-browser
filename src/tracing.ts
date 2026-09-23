import { safeUrl, globMatch, randomBytes, toHex, timeOrigin } from "./utils.js";
import { onBeforeRequest } from "./network-hook.js";

const TRACE_ID_BYTES = 16;
const SPAN_ID_BYTES = 8;
// Errors kept on one navigation. A page that throws in a loop would otherwise
// grow this without limit.
const MAX_EXCEPTIONS = 25;

/** An error that happened during a navigation. It rides the navigation's span
 * as an event, which is how OpenTelemetry records an error. */
export interface TracedException {
  name: string;
  message: string;
  stack?: string;
  timestamp: number;
}

/** The span for one navigation, ready to export. Every request the page made
 * hangs off it, so the backend spans have a parent that exists and the trace
 * says which page asked for them. */
export interface NavigationSpan {
  trace_id: string;
  span_id: string;
  action: string;
  start_time: number;
  end_time: number;
  exceptions: TracedException[];
}

let targets: string[] = [];
// Names the route. Passed in rather than read from the vitals module, so this
// module keeps no opinion about where a route lives.
let resolveRoute: (() => string) | null = null;
let unregister: (() => void) | null = null;

let traceId: string | null = null;
let spanId: string | null = null;
let action = "";
let startTime = 0;
let exceptions: TracedException[] = [];
// A span is exported once, when it ends. Without this a second flush would
// declare the same span again with a different end time.
let exported = false;

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
      action = resolveRoute ? resolveRoute() : "";
    }

    // The navigation span parents every request of the page, so each backend
    // span has a parent that exists and the page reads as one trace.
    ctx.headers.set("traceparent", `00-${traceId}-${spanId}-01`);
    ctx.trace = { trace_id: traceId };
  });
}

/** Attach an error to the navigation it happened in. Dropped when the page has
 * propagated nothing, because then no span exists for it to belong to. */
export function recordException(exception: TracedException): void {
  if (traceId === null || exported) return;
  if (exceptions.length >= MAX_EXCEPTIONS) return;
  exceptions.push(exception);
}

/** End the navigation and take its span, or nothing when there is none to
 * send. A navigation that propagated no request has no span, one already
 * exported must not be declared twice, and one that went well has nothing to
 * report: the backend already described every request it served. */
export function endNavigation(): NavigationSpan | undefined {
  if (traceId === null || spanId === null || exported) return undefined;
  if (exceptions.length === 0) return undefined;
  exported = true;
  return {
    trace_id: traceId,
    span_id: spanId,
    action,
    start_time: startTime,
    end_time: Date.now(),
    exceptions,
  };
}

/** Start the next navigation's trace. A route change ends the page the trace
 * describes, and a single-page app would otherwise build one trace that never
 * ends. */
export function markTracingNavigation(): void {
  traceId = null;
  spanId = null;
  action = "";
  startTime = Date.now();
  exceptions = [];
  exported = false;
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
  action = "";
  startTime = 0;
  exceptions = [];
  exported = false;
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
