import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTraceEnvelope } from "./otlp.js";
import { getNavigation } from "./tracing.js";
import type { Breadcrumb } from "./types.js";

vi.mock("./tracing.js", () => ({ getNavigation: vi.fn() }));

const OPTIONS = {
  serviceName: "Browser",
  revision: "abc123",
  appName: "AppSignal",
  environment: "development",
};

const ERROR = {
  name: "TypeError",
  message: "Cannot read properties of undefined",
  stack: "TypeError: Cannot read properties of undefined\n  at onCheckout",
  timestamp: 2000,
};

const TRACE_ID = "a".repeat(32);
const SPAN_ID = "f".repeat(16);

function networkBreadcrumb(data: Record<string, unknown>, timestamp = 1000): Breadcrumb {
  return { timestamp, category: "network", message: "POST /api", data };
}

const REQUEST = {
  method: "POST",
  url: "http://localhost/api/prices",
  status: 500,
  duration: 100,
  trace_id: TRACE_ID,
};

describe("buildTraceEnvelope", () => {
  beforeEach(() => {
    vi.mocked(getNavigation).mockReset();
    vi.mocked(getNavigation).mockReturnValue({
      trace_id: TRACE_ID,
      span_id: SPAN_ID,
      action: "/checkout",
      start_time: 900,
    });
  });

  it("returns nothing when no breadcrumb carried a trace", () => {
    const breadcrumbs = [
      networkBreadcrumb({ method: "GET", url: "http://localhost/api/poll", status: 200 }),
      { timestamp: 1000, category: "click", message: "button" } as Breadcrumb,
    ];
    expect(buildTraceEnvelope(breadcrumbs, ERROR, OPTIONS)).toBeUndefined();
  });

  it("declares one span for the navigation the error happened in", () => {
    const envelope = buildTraceEnvelope([networkBreadcrumb(REQUEST)], ERROR, OPTIONS);
    const spans = envelope!.resourceSpans[0].scopeSpans[0].spans;

    expect(spans).toHaveLength(1);
    expect(spans[0].traceId).toBe(TRACE_ID);
    // The ID the traceparent already committed, so the backend spans built from
    // that header have a parent that exists.
    expect(spans[0].spanId).toBe(SPAN_ID);
    expect(spans[0].name).toBe("/checkout");
    expect(spans[0].startTimeUnixNano).toBe("900000000");
  });

  it("records the error as an exception event, not a span of its own", () => {
    const envelope = buildTraceEnvelope([networkBreadcrumb(REQUEST)], ERROR, OPTIONS);
    const span = envelope!.resourceSpans[0].scopeSpans[0].spans[0];

    expect(span.events).toHaveLength(1);
    expect(span.events[0].name).toBe("exception");
    expect(span.events[0].attributes).toContainEqual({
      key: "exception.type",
      value: { stringValue: "TypeError" },
    });
    expect(span.events[0].attributes).toContainEqual({
      key: "exception.message",
      value: { stringValue: ERROR.message },
    });
    expect(span.status.code).toBe(2);
  });

  it("states the last request as a fact, with the gap, not as the cause", () => {
    const envelope = buildTraceEnvelope(
      [
        networkBreadcrumb({ ...REQUEST, url: "http://localhost/api/cart" }, 1000),
        networkBreadcrumb({ ...REQUEST, url: "http://localhost/api/prices" }, 1500),
      ],
      ERROR,
      OPTIONS,
    );
    const span = envelope!.resourceSpans[0].scopeSpans[0].spans[0];

    expect(span.attributes).toContainEqual({
      key: "appsignal.last_request",
      value: { stringValue: "POST http://localhost/api/prices 500" },
    });
    // The request ended at 1500 + 100ms; the error was at 2000.
    expect(span.attributes).toContainEqual({
      key: "appsignal.last_request.ms_before",
      value: { stringValue: "400" },
    });
  });

  it("takes the navigation of the most recent trace, not the route before it", () => {
    const older = "b".repeat(32);
    vi.mocked(getNavigation).mockImplementation((id: string) =>
      id === TRACE_ID
        ? { trace_id: TRACE_ID, span_id: SPAN_ID, action: "/checkout", start_time: 900 }
        : { trace_id: older, span_id: "0".repeat(16), action: "/cart", start_time: 100 },
    );

    const envelope = buildTraceEnvelope(
      [
        networkBreadcrumb({ ...REQUEST, trace_id: older }, 500),
        networkBreadcrumb(REQUEST, 1500),
      ],
      ERROR,
      OPTIONS,
    );

    expect(envelope!.resourceSpans[0].scopeSpans[0].spans[0].name).toBe("/checkout");
  });

  it("names the app so the collector does not route the span to one of its own", () => {
    const envelope = buildTraceEnvelope([networkBreadcrumb(REQUEST)], ERROR, OPTIONS);
    const attributes = envelope!.resourceSpans[0].resource.attributes;

    expect(attributes).toContainEqual({ key: "service.name", value: { stringValue: "Browser" } });
    expect(attributes).toContainEqual({
      key: "appsignal.config.name",
      value: { stringValue: "AppSignal" },
    });
  });
});
