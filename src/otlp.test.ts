import { describe, it, expect } from "vitest";
import { buildTraceEnvelope } from "./otlp.js";
import type { NavigationSpan } from "./tracing.js";

const OPTIONS = {
  serviceName: "Browser",
  revision: "abc123",
  appName: "AppSignal",
  environment: "development",
};

const NAVIGATION: NavigationSpan = {
  trace_id: "a".repeat(32),
  span_id: "f".repeat(16),
  action: "/checkout",
  start_time: 1000,
  end_time: 4000,
  exceptions: [],
};

const ERROR = {
  name: "TypeError",
  message: "Cannot read properties of undefined",
  stack: "TypeError: Cannot read properties of undefined\n  at onCheckout",
  timestamp: 2000,
};

function spanOf(envelope: ReturnType<typeof buildTraceEnvelope>) {
  return envelope.resourceSpans[0].scopeSpans[0].spans[0];
}

describe("buildTraceEnvelope", () => {
  it("declares the navigation with the IDs the traceparent already sent", () => {
    const span = spanOf(buildTraceEnvelope(NAVIGATION, OPTIONS));

    expect(span.traceId).toBe("a".repeat(32));
    // The backend spans built from that header point at this ID.
    expect(span.spanId).toBe("f".repeat(16));
    expect(span.name).toBe("/checkout");
    expect(span.startTimeUnixNano).toBe("1000000000");
    expect(span.endTimeUnixNano).toBe("4000000000");
  });

  it("leaves a navigation that went well without an error status", () => {
    const span = spanOf(buildTraceEnvelope(NAVIGATION, OPTIONS));

    expect(span.events).toHaveLength(0);
    expect(span.status).toBeUndefined();
  });

  it("records every error as an exception event on the one span", () => {
    const span = spanOf(
      buildTraceEnvelope(
        { ...NAVIGATION, exceptions: [ERROR, { ...ERROR, name: "RangeError", message: "second" }] },
        OPTIONS,
      ),
    );

    expect(span.events).toHaveLength(2);
    expect(span.events[0].name).toBe("exception");
    expect(span.events[0].attributes).toContainEqual({
      key: "exception.type",
      value: { stringValue: "TypeError" },
    });
    expect(span.events[1].attributes).toContainEqual({
      key: "exception.message",
      value: { stringValue: "second" },
    });
    expect(span.status?.code).toBe(2);
  });

  it("names the app so a receiver does not route the span to one of its own", () => {
    const attributes = buildTraceEnvelope(NAVIGATION, OPTIONS).resourceSpans[0].resource.attributes;

    expect(attributes).toContainEqual({ key: "service.name", value: { stringValue: "Browser" } });
    expect(attributes).toContainEqual({
      key: "appsignal.config.name",
      value: { stringValue: "AppSignal" },
    });
    expect(attributes).toContainEqual({
      key: "appsignal.config.revision",
      value: { stringValue: "abc123" },
    });
  });

  it("falls back to a name when the host declared no route", () => {
    expect(spanOf(buildTraceEnvelope({ ...NAVIGATION, action: "" }, OPTIONS)).name).toBe(
      "navigation",
    );
  });
});
