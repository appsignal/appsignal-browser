import { describe, it, expect } from "vitest";
import { buildErrorChain } from "./error-chain.js";
import type { Breadcrumb } from "./types.js";

const NAVIGATION = { trace_id: "a".repeat(32), span_id: "1".repeat(16), start_time: 1_000 };

function click(timestamp: number, message = 'button "Checkout"'): Breadcrumb {
  return { timestamp, category: "click", message };
}

/** A request the page traced, carrying the span ID it put in its
 * `traceparent`. */
function request(timestamp: number, spanId = "b".repeat(16), url = "/api/prices"): Breadcrumb {
  return {
    timestamp,
    category: "network",
    message: url,
    data: { span_id: spanId, method: "POST", url, duration: 20, status: 200 },
  };
}

/** The marker the SDK records for the page it started on: no `from`, because
 * nobody navigated there. */
function arrival(timestamp: number, url = "http://app.test/checkout"): Breadcrumb {
  return { timestamp, category: "navigation", message: url, data: { to: url } };
}

/** A route change inside the app. */
function routeChange(timestamp: number): Breadcrumb {
  return {
    timestamp,
    category: "navigation",
    message: "/cart → /checkout",
    data: { from: "/cart", to: "/checkout" },
  };
}

function errorAt(timestamp: number) {
  return { name: "TypeError", message: "total is undefined", timestamp };
}

describe("buildErrorChain", () => {
  it("nests the action and the request that failed under it", () => {
    const { spans, onSpanId } = buildErrorChain(
      NAVIGATION,
      [click(1_100), request(1_200)],
      errorAt(1_300),
    );

    const [action, failing] = spans;
    expect(action.parent_span_id).toBe(NAVIGATION.span_id);
    expect(failing.parent_span_id).toBe(action.span_id);
    // The exception belongs on the request, the innermost thing that ran.
    expect(onSpanId).toBe(failing.span_id);
  });

  it("keeps the span ID the request put in its traceparent", () => {
    const { spans } = buildErrorChain(NAVIGATION, [request(1_200, "e".repeat(16))], errorAt(1_300));

    // The backend spans that request produced point at this ID, so it has to
    // survive to the span the browser declares or they nest under nothing.
    expect(spans[0].span_id).toBe("e".repeat(16));
    expect(spans[0].kind).toBe("client");
  });

  it("does not treat arriving on the page as something the person did", () => {
    const { spans } = buildErrorChain(
      NAVIGATION,
      [arrival(1_000), request(1_200)],
      errorAt(1_300),
    );

    // The root span already names this page, and nobody navigated to it.
    expect(spans).toHaveLength(1);
    expect(spans[0].kind).toBe("client");
  });

  it("treats a route change as something the person did", () => {
    const { spans } = buildErrorChain(
      NAVIGATION,
      [routeChange(1_100), request(1_200)],
      errorAt(1_300),
    );

    expect(spans[0].name).toContain("/cart → /checkout");
  });

  it("names the click, not a later reading of the same click", () => {
    const rage: Breadcrumb = { timestamp: 1_100, category: "rage_click", message: "button" };
    const dead: Breadcrumb = { timestamp: 1_100, category: "dead_click", message: "button" };

    const { spans } = buildErrorChain(
      NAVIGATION,
      // The SDK appends its readings after the click they describe.
      [click(1_100), rage, dead, request(1_200)],
      errorAt(1_300),
    );

    expect(spans[0].name).toContain('button "Checkout"');
  });

  it("does not reach into the interaction before this trace", () => {
    // The ring outlives a trace: this request belongs to the interaction before
    // the rotation, and a backend span in that trace already points at its ID.
    const earlier = request(500, "a".repeat(16), "/api/cart");
    const trace = { ...NAVIGATION, start_time: 1_000 };

    const { spans, onSpanId } = buildErrorChain(trace, [earlier], errorAt(1_300));

    expect(spans).toEqual([]);
    expect(onSpanId).toBe(trace.span_id);
  });

  it("keeps what happened inside this trace", () => {
    const trace = { ...NAVIGATION, start_time: 1_000 };

    const { spans } = buildErrorChain(
      trace,
      [request(500, "a".repeat(16), "/api/cart"), click(1_100), request(1_200)],
      errorAt(1_300),
    );

    expect(spans).toHaveLength(2);
    expect(spans[1].span_id).toBe("b".repeat(16));
  });

  it("skips a request the page never traced", () => {
    const untraced: Breadcrumb = {
      timestamp: 1_250,
      category: "network",
      message: "https://maps.example.com/tiles",
      data: { method: "GET", url: "https://maps.example.com/tiles" },
    };

    const { spans } = buildErrorChain(NAVIGATION, [untraced], errorAt(1_300));

    // Somebody else's host, outside the trace: it belongs in the breadcrumbs.
    expect(spans).toEqual([]);
  });

  it("gives the action no duration, because nothing measured one", () => {
    const { spans } = buildErrorChain(
      NAVIGATION,
      [click(1_100), request(1_200)],
      errorAt(1_300),
    );

    // The gap between the click and the error is not how long the click took.
    const [action] = spans;
    expect(action.end_time).toBe(action.start_time);
  });

  it("describes one action once, however many errors followed it", () => {
    const breadcrumbs = [click(1_100), request(1_200)]
    const first = buildErrorChain(NAVIGATION, breadcrumbs, errorAt(1_300));
    const second = buildErrorChain(NAVIGATION, breadcrumbs, errorAt(1_400));

    // Two errors after one click are two errors, not two clicks. A fresh ID
    // each time would declare the same action twice under IDs nothing can
    // reconcile, and the trace would show it twice.
    expect(second.spans[0].span_id).toBe(first.spans[0].span_id);
    expect(second.spans[1].span_id).toBe(first.spans[1].span_id);
  });

  it("puts the exception on the navigation when the page did nothing", () => {
    const { spans, onSpanId } = buildErrorChain(NAVIGATION, [], errorAt(1_300));

    expect(spans).toEqual([]);
    expect(onSpanId).toBe(NAVIGATION.span_id);
  });
});
