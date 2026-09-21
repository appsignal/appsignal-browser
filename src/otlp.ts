// OTLP/HTTP JSON for the navigation an error happened in. One span: the backend
// already reports one per request it served, and those hang off this one. What
// it cannot know is which page asked, so that is what this says.

import type { Breadcrumb } from "./types.js";
import { getNavigation } from "./tracing.js";

// OTLP SpanKind.INTERNAL and StatusCode.ERROR.
const SPAN_KIND_INTERNAL = 1;
const STATUS_CODE_ERROR = 2;

const SCOPE_NAME = "@appsignal/browser";
// The build replaces this. Tests run the source, where it does not exist.
declare const __SDK_VERSION__: string | undefined;
const SCOPE_VERSION = typeof __SDK_VERSION__ === "string" ? __SDK_VERSION__ : undefined;

type Attribute = { key: string; value: { stringValue: string } };

interface OtlpSpan {
  traceId: string;
  spanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attribute[];
  events: { name: string; timeUnixNano: string; attributes: Attribute[] }[];
  status: { code: number; message?: string };
}

export interface TraceEnvelope {
  resourceSpans: {
    resource: { attributes: Attribute[] };
    scopeSpans: { scope: { name: string; version?: string }; spans: OtlpSpan[] }[];
  }[];
}

export interface EnvelopeOptions {
  serviceName: string;
  /** The host's build, from `BrowserConfig.appVersion`. */
  revision?: string;
  /** The AppSignal app these spans belong to. Without it an OTLP receiver routes
   * them to an app of their own rather than the host's. */
  appName?: string;
  environment?: string;
}

export interface ErrorForTrace {
  name: string;
  message: string;
  stack?: string;
  timestamp: number;
}

/** The navigation span an error belongs to, or undefined when none of the
 * error's breadcrumbs carried a trace. Without one there is no navigation to
 * name, and a span would claim a link that does not exist. */
export function buildTraceEnvelope(
  breadcrumbs: Breadcrumb[],
  error: ErrorForTrace,
  options: EnvelopeOptions,
): TraceEnvelope | undefined {
  const navigation = navigationFor(breadcrumbs);
  if (!navigation) return undefined;

  const attributes = [str("appsignal.action", navigation.action)];
  // The request before the error, and how long before. Not the request that
  // caused it: plenty of errors have no request behind them at all, and naming
  // one as the cause sends a reader to an endpoint that did nothing. The gap
  // says how much to believe it.
  const last = lastRequest(breadcrumbs);
  if (last) {
    attributes.push(str("appsignal.last_request", last.name));
    attributes.push(str("appsignal.last_request.ms_before", String(Math.max(0, error.timestamp - last.at))));
  }

  const span: OtlpSpan = {
    traceId: navigation.trace_id,
    spanId: navigation.span_id,
    name: navigation.action || "navigation",
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: nanos(navigation.start_time),
    endTimeUnixNano: nanos(error.timestamp),
    attributes,
    events: [exceptionEvent(error)],
    status: { code: STATUS_CODE_ERROR, message: error.message },
  };

  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes(options) },
        scopeSpans: [{ scope: { name: SCOPE_NAME, version: SCOPE_VERSION }, spans: [span] }],
      },
    ],
  };
}

/** The navigation of the most recent breadcrumb that carried a trace. The most
 * recent, because a route change starts a new trace while the breadcrumbs of
 * the route before it are still in the buffer. */
function navigationFor(breadcrumbs: Breadcrumb[]) {
  for (let index = breadcrumbs.length - 1; index >= 0; index--) {
    const traceId = (breadcrumbs[index].data as Record<string, unknown> | undefined)?.trace_id;
    if (typeof traceId !== "string") continue;
    const navigation = getNavigation(traceId);
    if (navigation) return navigation;
  }
  return undefined;
}

/** The last request before the error, and when it ended. The status rides
 * along, because a request that answered 200 with an unexpected body breaks as
 * much code as one that failed, and only the reader can tell which happened. */
function lastRequest(breadcrumbs: Breadcrumb[]): { name: string; at: number } | undefined {
  for (let index = breadcrumbs.length - 1; index >= 0; index--) {
    const breadcrumb = breadcrumbs[index];
    if (breadcrumb.category !== "network") continue;
    const data = breadcrumb.data as Record<string, unknown> | undefined;
    const method = typeof data?.method === "string" ? data.method : "GET";
    const url = typeof data?.url === "string" ? data.url : "";
    if (!url) continue;
    const duration = typeof data?.duration === "number" ? data.duration : 0;
    const at = breadcrumb.timestamp + duration;
    if (data?.error === true) return { name: `${method} ${url} (failed)`, at };
    const status = typeof data?.status === "number" ? ` ${data.status}` : "";
    return { name: `${method} ${url}${status}`, at };
  }
  return undefined;
}

/** OpenTelemetry records an error as an event on its span, not as a span. */
function exceptionEvent(error: ErrorForTrace): OtlpSpan["events"][number] {
  const attributes = [
    str("exception.type", error.name),
    str("exception.message", error.message),
  ];
  if (error.stack) attributes.push(str("exception.stacktrace", error.stack));
  return { name: "exception", timeUnixNano: nanos(error.timestamp), attributes };
}

function resourceAttributes(options: EnvelopeOptions): Attribute[] {
  const attributes = [str("service.name", options.serviceName)];
  if (options.appName) attributes.push(str("appsignal.config.name", options.appName));
  if (options.environment) {
    attributes.push(str("appsignal.config.environment", options.environment));
  }
  if (options.revision) attributes.push(str("appsignal.config.revision", options.revision));
  return attributes;
}

/** OTLP times are unix nanoseconds, stringified because the value exceeds
 * what a number holds exactly. */
function nanos(epochMs: number): string {
  return String(Math.round(epochMs) * 1_000_000);
}

function str(key: string, value: string): Attribute {
  return { key, value: { stringValue: value } };
}
