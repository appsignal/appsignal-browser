import type { TraceContext } from "./types.js";
import { safeUrl, globMatch, timeOrigin } from "./utils.js";
import { onBeforeRequest } from "./network-hook.js";
import { sendPageLoad } from "./transport.js";
import { getRouteAction } from "./vitals.js";
import { getTags } from "./session.js";

let targets: string[] = [];
let unregister: (() => void) | null = null;
// The host's config, carried on the page_load post so its identity matches
// what the closing object and error payloads send. See BrowserConfig.appVersion
// and BrowserConfig.serviceName.
let appVersion: string | undefined;
let serviceName: string | undefined;

// One trace and span ID per navigation, shared by every propagated request in
// it. That makes each backend request a child of the browser's page load span,
// which is the standard model for browser tracing: one trace per page load
// rather than one per request. They are generated on the first propagated
// request and cleared at the next navigation, so a long-lived single-page app
// does not accumulate one ever-growing trace.
let traceId: string | null = null;
let spanId: string | null = null;
// Start of the current navigation, in epoch ms. The landing route starts at the
// page's time origin; later routes start when the navigation happens.
let navigationStart = 0;

export function initTracing(
  tracePropagationTargets: string[],
  version?: string,
  service?: string,
): void {
  targets = tracePropagationTargets;
  appVersion = version;
  serviceName = service;
  if (targets.length === 0) return;

  navigationStart = timeOrigin();

  unregister = onBeforeRequest((ctx) => {
    if (!shouldPropagate(ctx.url)) return;

    const firstOfNavigation = traceId === null || spanId === null;
    if (firstOfNavigation) {
      traceId = randomHex(16);
      spanId = randomHex(8);
    }
    const trace = traceId as string;
    const span = spanId as string;
    ctx.headers.set("traceparent", `00-${trace}-${span}-01`);

    // Declare the page load span the moment something first refers to it. The
    // backend span created from this header points at our span ID, so a span
    // with that ID has to exist for the trace to make sense. Sending it here
    // rather than at navigation start also means it can carry an action: data
    // fetching is triggered from the host's effects, so its router has
    // usually already declared the route template by now.
    //
    // Fire and forget. It may race the request it accompanies, and it may
    // arrive after an error or the events post. The server merges the writes
    // for one span in any order, so none of that matters.
    if (firstOfNavigation) {
      sendPageLoad({
        type: "page_load",
        trace_id: trace,
        span_id: span,
        start_time: navigationStart,
        action: getRouteAction(),
        app_version: appVersion,
        service_name: serviceName,
        tags: getTags(),
      });
    }
  });
}

/** The trace and span ID of the current navigation's page load span, plus its
 * start time, or undefined when there is none. There is none until a request
 * has actually propagated a `traceparent`: nothing refers to the span before
 * that, so nothing should claim it exists. */
export function getTraceContext(): TraceContext | undefined {
  if (traceId === null || spanId === null) return undefined;
  return { trace_id: traceId, span_id: spanId, start_time: navigationStart };
}

/** The current navigation's trace ID, but only for a URL we actually propagate
 * to. A breadcrumb's `trace_id` claims the request is part of that trace, which
 * is only true for a request that carried the header, so a request to a
 * non-target must not get one. Before this module tracked one trace per
 * navigation it held a per-URL queue, which gave the same answer as a side
 * effect; the URL check keeps that behaviour explicit. */
export function traceIdForUrl(url: string): string | undefined {
  if (traceId === null || !shouldPropagate(url)) return undefined;
  return traceId;
}

/** Start a new navigation's trace. Call after the outgoing navigation has been
 * flushed, so its events post still carries the identity it declared. */
export function markTracingNavigation(): void {
  traceId = null;
  spanId = null;
  navigationStart = Date.now();
}

export function destroyTracing(): void {
  if (unregister) {
    unregister();
    unregister = null;
  }
  targets = [];
  traceId = null;
  spanId = null;
  navigationStart = 0;
  appVersion = undefined;
  serviceName = undefined;
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
