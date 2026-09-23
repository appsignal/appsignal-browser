// OTLP/HTTP JSON for a navigation's span. One span: the backend already reports
// one per request it served, and those hang off this one. What it cannot know is
// which page asked, so that is what this says.

import type { NavigationSpan, TracedException } from "./tracing.js";

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
  status?: { code: number; message?: string };
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
  /** The AppSignal app these spans belong to. Without it an OTLP receiver
   * routes them to an app of their own rather than the host's. */
  appName?: string;
  environment?: string;
}

/** The OTLP envelope for one navigation. */
export function buildTraceEnvelope(
  navigation: NavigationSpan,
  options: EnvelopeOptions,
): TraceEnvelope {
  const failed = navigation.exceptions.length > 0;
  const span: OtlpSpan = {
    traceId: navigation.trace_id,
    spanId: navigation.span_id,
    name: navigation.action || "navigation",
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: nanos(navigation.start_time),
    endTimeUnixNano: nanos(navigation.end_time),
    attributes: [str("appsignal.action", navigation.action)],
    events: navigation.exceptions.map(exceptionEvent),
  };
  if (failed) {
    span.status = { code: STATUS_CODE_ERROR, message: navigation.exceptions[0].message };
  }

  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes(options) },
        scopeSpans: [{ scope: { name: SCOPE_NAME, version: SCOPE_VERSION }, spans: [span] }],
      },
    ],
  };
}

/** OpenTelemetry records an error as an event on its span, not as a span. */
function exceptionEvent(exception: TracedException): OtlpSpan["events"][number] {
  const attributes = [
    str("exception.type", exception.name),
    str("exception.message", exception.message),
  ];
  if (exception.stack) attributes.push(str("exception.stacktrace", exception.stack));
  return { name: "exception", timeUnixNano: nanos(exception.timestamp), attributes };
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

/** OTLP times are unix nanoseconds, stringified because the value exceeds what
 * a number holds exactly. */
function nanos(epochMs: number): string {
  return String(Math.round(epochMs) * 1_000_000);
}

function str(key: string, value: string): Attribute {
  return { key, value: { stringValue: value } };
}
