import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  initNetworkHook,
  destroyNetworkHook,
  onBeforeRequest,
} from "./network-hook.js";

// Capture what origFetch actually receives so we can assert on the headers
// the wrapper forwards. The real network never runs.
let lastInput: RequestInfo | URL;
let lastInit: RequestInit | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

/** Resolve the effective headers the way the platform would for
 * `fetch(input, init)` — Request headers as the base, init headers overriding
 * — so the assertion reflects what the server would actually see. */
function effectiveHeaders(): Headers {
  return new Request(lastInput as Request | string, lastInit).headers;
}

beforeEach(() => {
  lastInit = undefined;
  fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    lastInput = input;
    lastInit = init;
    return Promise.resolve(new Response("ok", { status: 200 }));
  });
  window.fetch = fetchMock as unknown as typeof window.fetch;
  initNetworkHook();
});

afterEach(() => {
  destroyNetworkHook();
});

describe("network-hook fetch header preservation", () => {
  it("preserves headers carried on a Request input (no init)", async () => {
    const req = new Request("https://example.com/api", {
      headers: { authorization: "Bearer SECRET", "x-custom": "1" },
    });
    await window.fetch(req);

    const headers = effectiveHeaders();
    expect(headers.get("authorization")).toBe("Bearer SECRET");
    expect(headers.get("x-custom")).toBe("1");
  });

  it("preserves Request headers when init carries unrelated options", async () => {
    const req = new Request("https://example.com/api", {
      headers: { authorization: "Bearer SECRET" },
    });
    await window.fetch(req, { method: "POST", body: "x" });

    expect(effectiveHeaders().get("authorization")).toBe("Bearer SECRET");
  });

  it("preserves headers passed via init on a string URL", async () => {
    await window.fetch("https://example.com/api", {
      headers: { authorization: "Bearer SECRET" },
    });

    expect(effectiveHeaders().get("authorization")).toBe("Bearer SECRET");
  });

  it("lets a before-listener add a header without clobbering the caller's", async () => {
    onBeforeRequest((ctx) => ctx.headers.set("traceparent", "00-abc-def-01"));

    const req = new Request("https://example.com/api", {
      headers: { authorization: "Bearer SECRET" },
    });
    await window.fetch(req);

    // The wrapper forwards an explicit headers object in this path; assert on
    // it directly so we know the listener's header rode along with the
    // caller's, neither dropped.
    const forwarded = new Headers(lastInit?.headers);
    expect(forwarded.get("authorization")).toBe("Bearer SECRET");
    expect(forwarded.get("traceparent")).toBe("00-abc-def-01");
  });
});
