// OTLP/HTTP JSON for one trace root. One span: the backend already reports
// one per request it served, and those hang off this one. What it cannot know is
// which page asked, so that is what this says.

import type { AttributeValue, ChainSpan, TraceRoot, TracedException } from "./tracing.js";

// OTLP SpanKind.INTERNAL, SpanKind.CLIENT and StatusCode.ERROR.
const SPAN_KIND_INTERNAL = 1;
const SPAN_KIND_CLIENT = 3;
const STATUS_CODE_ERROR = 2;

const SCOPE_NAME = "@appsignal/browser";
// The build replaces this. Tests run the source, where it does not exist.
declare const __SDK_VERSION__: string | undefined;
const SCOPE_VERSION = typeof __SDK_VERSION__ === "string" ? __SDK_VERSION__ : undefined;

type AnyValue = { stringValue: string } | { intValue: string };
type Attribute = { key: string; value: AnyValue };

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
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

/** The OTLP envelope for one trace root and the spans that led to its errors. */
export function buildTraceEnvelope(
  traceRoot: TraceRoot,
  options: EnvelopeOptions,
): TraceEnvelope {
  const failed = traceRoot.exceptions.length > 0;
  const root: OtlpSpan = {
    traceId: traceRoot.trace_id,
    spanId: traceRoot.span_id,
    name: traceRoot.action || "navigation",
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: nanos(traceRoot.start_time),
    endTimeUnixNano: nanos(traceRoot.end_time),
    attributes: [attr("appsignal.action", traceRoot.action)],
    events: exceptionsOn(traceRoot, traceRoot.span_id).map(exceptionEvent),
  };
  if (failed) {
    root.status = { code: STATUS_CODE_ERROR, message: traceRoot.exceptions[0].message };
  }

  const spans = [root, ...traceRoot.chain.map((span) => chainSpan(span, traceRoot))];

  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes(options) },
        scopeSpans: [{ scope: { name: SCOPE_NAME, version: SCOPE_VERSION }, spans }],
      },
    ],
  };
}

function chainSpan(span: ChainSpan, traceRoot: TraceRoot): OtlpSpan {
  const attributes = Object.entries(span.attributes ?? {}).map(([key, value]) =>
    attr(key, value),
  );
  const failures = exceptionsOn(traceRoot, span.span_id);
  const events = failures.map(exceptionEvent);
  const otlp: OtlpSpan = {
    traceId: traceRoot.trace_id,
    spanId: span.span_id,
    parentSpanId: span.parent_span_id,
    name: span.name,
    // A request is CLIENT, not INTERNAL: that is what tells a trace view the
    // span below it was served by somebody else, and lets it draw the hop.
    kind: span.kind === "client" ? SPAN_KIND_CLIENT : SPAN_KIND_INTERNAL,
    startTimeUnixNano: nanos(span.start_time),
    endTimeUnixNano: nanos(span.end_time),
    attributes,
    events,
  };
  if (failures.length > 0) {
    otlp.status = { code: STATUS_CODE_ERROR, message: failures[0].message };
  }
  return otlp;
}

/** The errors that happened on one span. An error with no chain below it
 * belongs to the root itself. */
function exceptionsOn(traceRoot: TraceRoot, spanId: string): TracedException[] {
  return traceRoot.exceptions.filter(
    (exception) => (exception.on_span_id ?? traceRoot.span_id) === spanId,
  );
}

/** OpenTelemetry records an error as an event on its span, not as a span. */
function exceptionEvent(exception: TracedException): OtlpSpan["events"][number] {
  const attributes = [
    attr("exception.type", exception.name),
    attr("exception.message", exception.message),
  ];
  if (exception.stack) attributes.push(attr("exception.stacktrace", exception.stack));
  return { name: "exception", timeUnixNano: nanos(exception.timestamp), attributes };
}

function resourceAttributes(options: EnvelopeOptions): Attribute[] {
  const attributes = [attr("service.name", options.serviceName)];
  if (options.appName) attributes.push(attr("appsignal.config.name", options.appName));
  if (options.environment) {
    attributes.push(attr("appsignal.config.environment", options.environment));
  }
  if (options.revision) attributes.push(attr("appsignal.config.revision", options.revision));
  return attributes;
}

/** OTLP times are unix nanoseconds, stringified because the value exceeds what
 * a number holds exactly. */
function nanos(epochMs: number): string {
  return String(Math.round(epochMs) * 1_000_000);
}

/** An attribute of whichever type the conventions give it. OTLP/JSON writes an
 * int64 as a string, which is what a 64-bit value needs to survive JSON. */
function attr(key: string, value: AttributeValue): Attribute {
  return typeof value === "number"
    ? { key, value: { intValue: String(Math.round(value)) } }
    : { key, value: { stringValue: value } };
}
