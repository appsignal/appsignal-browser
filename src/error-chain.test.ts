import { describe, it, expect } from "vitest";
import { buildErrorChain } from "./error-chain.js";
import type { Breadcrumb } from "./types.js";

const NAVIGATION = { trace_id: "a".repeat(32), span_id: "1".repeat(16), start_time: 1_000 };

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

function errorAt(timestamp: number) {
  return { name: "TypeError", message: "total is undefined", timestamp };
}

describe("buildErrorChain", () => {
  it("hangs the failing request off the page", () => {
    const { spans, onSpanId } = buildErrorChain(NAVIGATION, [request(1_200)], errorAt(1_300));

    expect(spans).toHaveLength(1);
    expect(spans[0].parent_span_id).toBe(NAVIGATION.span_id);
    // The exception belongs on the request, the innermost thing that ran.
    expect(onSpanId).toBe(spans[0].span_id);
  });

  it("keeps the span ID the request put in its traceparent", () => {
    const { spans } = buildErrorChain(NAVIGATION, [request(1_200, "e".repeat(16))], errorAt(1_300));

    // The backend spans that request produced point at this ID, so it has to
    // survive to the span the browser declares or they nest under nothing.
    expect(spans[0].span_id).toBe("e".repeat(16));
    expect(spans[0].kind).toBe("client");
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

  it("puts the exception on the navigation when the page did nothing", () => {
    const { spans, onSpanId } = buildErrorChain(NAVIGATION, [], errorAt(1_300));

    expect(spans).toEqual([]);
    expect(onSpanId).toBe(NAVIGATION.span_id);
  });
});
