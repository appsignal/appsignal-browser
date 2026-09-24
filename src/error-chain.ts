// What led to an error, as far as the breadcrumbs can say: the page, and the
// last request before the error.
//
// The request is not observed to have caused the error. A browser cannot follow
// that link, because a framework that fetches from an effect breaks it
// deliberately. What the span says about itself is fact: the URL, the status,
// the timing. Where it sits is this module's best reading of the breadcrumbs.

import type { Breadcrumb } from "./types.js";
import type { AttributeValue, ChainSpan, TraceContext } from "./tracing.js";

export interface ChainedError {
  name: string;
  message: string;
  stack?: string;
  timestamp: number;
}

/** The spans describing one error. The caller declares them with the page, so
 * each one's parent is in the same payload. */
export function buildErrorChain(
  navigation: TraceContext,
  breadcrumbs: Breadcrumb[],
  error: ChainedError,
): { spans: ChainSpan[]; onSpanId: string } {
  const request = lastRequest(breadcrumbs, navigation.span_id, error.timestamp);
  if (!request) return { spans: [], onSpanId: navigation.span_id };

  return { spans: [request], onSpanId: request.span_id };
}

/** The last request the page traced, as the span that describes it. Its ID is
 * the one the request put in its `traceparent`, so the backend spans it made
 * already point at it and nest under it. A request the page did not trace is
 * somebody else's host, outside the trace, so it stays in the breadcrumbs. */
function lastRequest(
  breadcrumbs: Breadcrumb[],
  parentSpanId: string,
  before: number,
): ChainSpan | undefined {
  for (let index = breadcrumbs.length - 1; index >= 0; index--) {
    const breadcrumb = breadcrumbs[index];
    if (breadcrumb.category !== "network" || breadcrumb.timestamp > before) continue;

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
