import { safeUrl, globMatch, randomBytes, toHex, timeOrigin } from "./utils.js";
import { onBeforeRequest } from "./network-hook.js";

const TRACE_ID_BYTES = 16;
const SPAN_ID_BYTES = 8;
// Errors kept on one navigation. A page that throws in a loop would otherwise
// grow this without limit.
const MAX_EXCEPTIONS = 25;
// Traces an interaction ended, held until the next flush. A page that errors on
// every interaction would otherwise grow this without limit.
const MAX_FINISHED_TRACES = 25;

/** What a span attribute may hold. OpenTelemetry types its attributes, and the
 * conventions say which is which. `http.response.status_code` is an int, not
 * the string it renders as. */
export type AttributeValue = string | number;

/** A span below the navigation, describing what led to an error. Declared with
 * the navigation, so its parent is in the same payload. */
export interface ChainSpan {
  span_id: string;
  parent_span_id: string;
  name: string;
  start_time: number;
  end_time: number;
  /** A request the page made, rather than something it did. The trace views
   * read this to draw the hop from the browser to whoever answered. */
  kind: "client" | "internal";
  attributes?: Record<string, AttributeValue>;
}

/** The navigation an error belongs to. */
export interface TraceContext {
  trace_id: string;
  span_id: string;
  start_time: number;
}

/** An error that happened during a navigation. It rides the navigation's span
 * as an event, which is how OpenTelemetry records an error. */
export interface TracedException {
  name: string;
  message: string;
  stack?: string;
  timestamp: number;
  /** The innermost span of the chain that led here. The event goes on that
   * span, so a timeline marks the error where it happened rather than at the
   * page. */
  on_span_id?: string;
}

/** The root span of one trace, ready to export. A trace covers the page up to
 * the first thing the person did, and one interaction after that. Every request
 * inside it named this span as the parent in its `traceparent`, so the backend
 * spans have a parent that exists and the trace says what asked for them. */
export interface TraceRoot {
  trace_id: string;
  span_id: string;
  action: string;
  start_time: number;
  end_time: number;
  exceptions: TracedException[];
  /** Every span an error's chain added, by ID, so two errors that followed one
   * request describe it once. */
  chain: ChainSpan[];
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
let chain = new Map<string, ChainSpan>();
// A span is exported once, when it ends. Without this a second flush would
// declare the same span again with a different end time.
let exported = false;
// When the person last did something. The next request starts its own trace
// from here, so the page's own loading is not in the trace an error belongs to.
let interactionAt: number | null = null;
// Traces an interaction ended before anything flushed them.
let finished: TraceRoot[] = [];
// Span IDs the browser minted itself, by what they describe. Cleared with the
// trace they belong to.
let localSpanIds = new Map<string, string>();
let releaseGestures: (() => void) | null = null;

// What counts as the person doing something. Not "which request did this
// cause", which a browser cannot answer, but "did they act", which is fact.
const GESTURES = ["pointerdown", "keydown"] as const;

export function initTracing(
  tracePropagationTargets: string[],
  routeName?: () => string,
): void {
  targets = tracePropagationTargets;
  resolveRoute = routeName ?? null;
  startTime = timeOrigin();
  if (targets.length === 0) return;

  listenForGestures();

  unregister = onBeforeRequest((ctx) => {
    if (!shouldPropagate(ctx.url)) return;

    // The person acted since the last request, so this one belongs to what they
    // did rather than to the page that was already there. Rotating here rather
    // than in the listener costs nothing when they act and nothing follows.
    if (interactionAt !== null) rotate(interactionAt);

    // Minted on the first request that propagates, not when the trace starts.
    // Nothing refers to the span before that, and by now the host's router has
    // usually declared its route, so the span can carry one.
    if (traceId === null || spanId === null) {
      traceId = randomHex(TRACE_ID_BYTES);
      spanId = randomHex(SPAN_ID_BYTES);
      action = resolveRoute ? resolveRoute() : "";
    }

    // Its own CLIENT span per request, so the backend spans nest under the
    // request that asked for them rather than beside every other request. Only
    // the request an error describes is ever sent, so the rest name a span that
    // never arrives. A trace covers one interaction, which is usually that one
    // request, so there is little else in it to leave dangling.
    const clientSpanId = randomHex(SPAN_ID_BYTES);
    ctx.headers.set("traceparent", `00-${traceId}-${clientSpanId}-01`);
    ctx.trace = { trace_id: traceId, span_id: clientSpanId };
  });
}

/** The trace an error belongs to, or nothing when nothing has propagated a
 * request into it yet. */
export function getTraceContext(): TraceContext | undefined {
  if (traceId === null || spanId === null) return undefined;
  return { trace_id: traceId, span_id: spanId, start_time: startTime };
}

/** Attach an error to the trace it happened in, with the spans that led to it.
 * Dropped when nothing has propagated, because then no span exists for it to
 * belong to. */
export function recordException(
  exception: TracedException,
  chainSpans: ChainSpan[] = [],
): void {
  if (traceId === null || exported) return;
  if (exceptions.length >= MAX_EXCEPTIONS) return;
  exceptions.push(exception);
  // Keyed by ID: two errors after one request describe that request once.
  for (const span of chainSpans) {
    if (!chain.has(span.span_id)) chain.set(span.span_id, span);
  }
}

/** The span ID for something the browser did not put in a `traceparent`, stable
 * for as long as the trace lasts. Two errors after one click describe that
 * click once: minting a fresh ID each time would declare the same thing twice,
 * under two IDs nothing can reconcile. */
export function spanIdFor(key: string): string {
  let spanId = localSpanIds.get(key);
  if (!spanId) {
    spanId = randomHex(SPAN_ID_BYTES);
    localSpanIds.set(key, spanId);
  }
  return spanId;
}

/** Take every trace root there is to send: the ones an interaction already
 * ended, and the one still open. A trace that propagated no request has no
 * span, one already exported must not be declared twice, and one that went well
 * has nothing to report: the backend already described every request it
 * served. */
export function takeTraceRoots(): TraceRoot[] {
  const roots = finished;
  finished = [];
  const open = takeOpenRoot(Date.now());
  if (open) roots.push(open);
  return roots;
}

/** Start the next navigation's trace. A route change ends the page the trace
 * describes, and a single-page app would otherwise build one trace that never
 * ends. */
export function markTracingNavigation(): void {
  reset(Date.now());
}

export function destroyTracing(): void {
  if (unregister) {
    unregister();
    unregister = null;
  }
  if (releaseGestures) {
    releaseGestures();
    releaseGestures = null;
  }
  targets = [];
  resolveRoute = null;
  finished = [];
  reset(0);
}

/** Close the open trace so the next request starts a new one. Its errors are
 * kept: they are already recorded and nothing has sent them yet. */
function rotate(at: number): void {
  const open = takeOpenRoot(at);
  if (open) {
    // The oldest goes first: the newest interaction is the one somebody is
    // looking at when the page breaks.
    if (finished.length >= MAX_FINISHED_TRACES) finished.shift();
    finished.push(open);
  }
  reset(at);
}

function takeOpenRoot(endTime: number): TraceRoot | undefined {
  if (traceId === null || spanId === null || exported) return undefined;
  if (exceptions.length === 0) return undefined;
  exported = true;
  return {
    trace_id: traceId,
    span_id: spanId,
    action,
    start_time: startTime,
    end_time: endTime,
    exceptions,
    chain: [...chain.values()],
  };
}

function reset(at: number): void {
  traceId = null;
  spanId = null;
  action = "";
  startTime = at;
  exceptions = [];
  chain = new Map();
  exported = false;
  interactionAt = null;
  localSpanIds = new Map();
}

function listenForGestures(): void {
  if (typeof document === "undefined") return;
  const onGesture = () => {
    interactionAt = Date.now();
  };
  for (const name of GESTURES) {
    document.addEventListener(name, onGesture, { capture: true, passive: true });
  }
  releaseGestures = () => {
    for (const name of GESTURES) {
      document.removeEventListener(name, onGesture, true);
    }
  };
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
