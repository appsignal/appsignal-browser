// What led to an error, as far as the breadcrumbs can say: the navigation, the
// last thing the person did, and the last request before it.
//
// Both of those are placed by a heuristic, not observed. A browser cannot
// follow the chain from a click to the request it caused, because a framework
// that fetches from an effect breaks it deliberately. What each span says about
// itself is fact: the URL, the status, the timing. Where it sits in the tree is
// this module's best reading of the breadcrumbs.

import type { Breadcrumb } from "./types.js";
import type { AttributeValue, ChainSpan, TraceContext } from "./tracing.js";
import { spanIdFor } from "./tracing.js";

// What the person did, as opposed to what the page did. A click and a route
// change are the only two: `rage_click`, `dead_click` and `error_click` are
// readings of a click that already recorded itself. They would only change what
// this span is called, by whichever reading landed last.
const USER_ACTIONS = new Set(["click", "navigation"]);

export interface ChainedError {
  name: string;
  message: string;
  stack?: string;
  timestamp: number;
}

/** The spans describing one error, innermost last. The caller declares them
 * together, so each one's parent is in the same payload. */
export function buildErrorChain(
  navigation: TraceContext,
  breadcrumbs: Breadcrumb[],
  error: ChainedError,
): { spans: ChainSpan[]; onSpanId: string } {
  const spans: ChainSpan[] = [];
  let parentId = navigation.span_id;

  const within = inTrace(breadcrumbs, navigation.start_time, error.timestamp);

  const action = lastAction(within, parentId);
  if (action) {
    spans.push(action);
    parentId = action.span_id;
  }

  const request = lastRequest(within, parentId);
  if (request) {
    spans.push(request);
    parentId = request.span_id;
  }

  return { spans, onSpanId: parentId };
}

/** The last thing the person did, as the span that describes it. */
function lastAction(breadcrumbs: Breadcrumb[], parentSpanId: string): ChainSpan | undefined {
  const action = lastUserAction(breadcrumbs);
  if (!action) return undefined;

  return {
    // Keyed by the breadcrumb, not by this call: a second error after the same
    // action must describe it as the same span.
    span_id: spanIdFor(`${action.category}:${action.timestamp}`),
    parent_span_id: parentSpanId,
    name: `${action.category} ${action.message ?? ""}`.trim(),
    start_time: action.timestamp,
    // A point, not a length. Nothing measured how long the action took, and the
    // gap to the error is not its duration.
    end_time: action.timestamp,
    kind: "internal",
  };
}

/** The breadcrumbs this trace can speak for. The ring outlives a trace, so
 * without the lower bound a chain can reach into the interaction before it and
 * claim a span ID that already belongs to another trace. */
function inTrace(breadcrumbs: Breadcrumb[], from: number, until: number): Breadcrumb[] {
  return breadcrumbs.filter(
    (breadcrumb) => breadcrumb.timestamp >= from && breadcrumb.timestamp <= until,
  );
}

function lastUserAction(breadcrumbs: Breadcrumb[]): Breadcrumb | undefined {
  for (let index = breadcrumbs.length - 1; index >= 0; index--) {
    if (isUserAction(breadcrumbs[index])) return breadcrumbs[index];
  }
  return undefined;
}

function isUserAction(breadcrumb: Breadcrumb): boolean {
  if (!USER_ACTIONS.has(breadcrumb.category)) return false;
  // The SDK records where the page started as a navigation. Nobody navigated
  // there: they arrived, and the root span already names that page. A real one
  // says where it came from.
  if (breadcrumb.category === "navigation") {
    const data = breadcrumb.data as Record<string, unknown> | undefined;
    return typeof data?.from === "string";
  }
  return true;
}

/** The last request the page traced, as the span that describes it. Its ID is
 * the one the request put in its `traceparent`, so the backend spans it made
 * already point at it and nest under it. A request the page did not trace is
 * somebody else's host, outside the trace, so it stays in the breadcrumbs. */
function lastRequest(breadcrumbs: Breadcrumb[], parentSpanId: string): ChainSpan | undefined {
  for (let index = breadcrumbs.length - 1; index >= 0; index--) {
    const breadcrumb = breadcrumbs[index];
    if (breadcrumb.category !== "network") continue;

    const data = breadcrumb.data as Record<string, unknown> | undefined;
    const spanId = data?.span_id;
    if (typeof spanId !== "string") continue;

    const method = typeof data?.method === "string" ? data.method : "GET";
    const url = typeof data?.url === "string" ? data.url : "";
    const duration = typeof data?.duration === "number" ? data.duration : 0;

    const attributes: Record<string, AttributeValue> = { "http.request.method": method };
    if (url) {
      attributes["url.full"] = url;
      // The path as its own attribute, because the span may not carry it in its
      // name: a reader that wants to show the target has it here.
      attributes["url.path"] = path(url);
    }
    if (typeof data?.status === "number") {
      attributes["http.response.status_code"] = data.status;
    }

    return {
      span_id: spanId,
      parent_span_id: parentSpanId,
      // `{method}`, not `{method} {path}`. The HTTP conventions name a client
      // span by its method alone: a path carrying an ID gives every request its
      // own span name, and nothing can group them. The path is an attribute.
      name: method,
      start_time: breadcrumb.timestamp,
      end_time: breadcrumb.timestamp + duration,
      kind: "client",
      attributes,
    };
  }
  return undefined;
}

function path(url: string): string {
  try {
    return new URL(url, location.origin).pathname;
  } catch {
    return url;
  }
}
