import type { TraceContext } from "./types.js";
import { safeUrl, globMatch, randomBytes, timeOrigin, toHex } from "./utils.js";
import { onBeforeRequest, onAfterRequest } from "./network-hook.js";
import { sendPageLoad } from "./transport.js";
import { getRouteAction } from "./vitals.js";
import { getTags } from "./session.js";

let targets: string[] = [];
let unregisters: (() => void)[] = [];
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
// Whether this navigation has sent its page_load post, and whether it has gone
// wrong. The post waits until both a traceparent has gone out and something went
// wrong, in either order, so a navigation that goes fine sends nothing about its
// span.
let declared = false;
let errored = false;

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

  unregisters.push(
    onBeforeRequest((ctx) => {
      if (!shouldPropagate(ctx.url)) return;

      if (traceId === null || spanId === null) {
        traceId = randomHex(16);
        spanId = randomHex(8);
      }
      ctx.headers.set("traceparent", `00-${traceId}-${spanId}-01`);

      // An error before the first propagated request had no span to join, so
      // the span is declared now, when something first refers to it.
      if (errored) declarePageLoad();
    }),
  );

  // A failed backend request often throws nothing in the browser, because the
  // host renders an error state instead. Treat it as the navigation going
  // wrong so its trace still gets a browser root.
  unregisters.push(
    onAfterRequest((result) => {
      if (!shouldPropagate(result.url)) return;
      if (result.error || (result.status ?? 0) >= 500) markTracingError();
    }),
  );
}

/** Record that the current navigation went wrong. This is what declares the
 * page load span: now if a traceparent has already gone out, otherwise on the
 * next propagated request. */
export function markTracingError(): void {
  errored = true;
  if (traceId !== null && spanId !== null) declarePageLoad();
}

// Fire and forget. It may race the request it accompanies, and it may arrive
// after an error or the events post. The server merges the writes for one span
// in any order, so none of that matters.
function declarePageLoad(): void {
  if (declared || traceId === null || spanId === null) return;
  declared = true;
  sendPageLoad({
    type: "page_load",
    trace_id: traceId,
    span_id: spanId,
    start_time: navigationStart,
    action: getRouteAction(),
    app_version: appVersion,
    service_name: serviceName,
    tags: getTags(),
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

/** The trace context, but only once the page_load post has declared the span.
 * The closing object on the events post uses this, so a navigation that never
 * went wrong sends nothing about its span at all. */
export function getDeclaredTraceContext(): TraceContext | undefined {
  return declared ? getTraceContext() : undefined;
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
  declared = false;
  errored = false;
}

export function destroyTracing(): void {
  for (const unregister of unregisters) unregister();
  unregisters = [];
  targets = [];
  traceId = null;
  spanId = null;
  navigationStart = 0;
  declared = false;
  errored = false;
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
  return toHex(randomBytes(numBytes));
}
