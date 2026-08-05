import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The action on an error payload is what the server groups incidents by. These
// tests drive the whole SDK rather than errors.ts in isolation, so the real
// route state in vitals.ts is what supplies the action. errors.test.ts covers
// the derivation with that state mocked; this file covers what several errors
// in one navigation report.

const { handlers } = vi.hoisted(() => {
  const handlers: Record<string, (m: Record<string, unknown>) => void> = {};
  return { handlers };
});
vi.mock("web-vitals", () => {
  const record = (name: string) => (cb: (m: Record<string, unknown>) => void) => {
    handlers[name] = cb;
  };
  return {
    onLCP: record("lcp"),
    onCLS: record("cls"),
    onINP: record("inp"),
    onFCP: record("fcp"),
    onTTFB: record("ttfb"),
  };
});

type SdkModule = typeof import("./index.js");

describe("error action across one navigation", () => {
  let sdk: SdkModule;
  let sent: { url: string; body: string }[] = [];

  function errorActions() {
    return sent
      .filter((p) => p.url.includes("/ingest/browser/errors"))
      .map((p) => JSON.parse(p.body).action as string);
  }

  beforeEach(async () => {
    sent = [];
    vi.resetModules();
    for (const k of Object.keys(handlers)) delete handlers[k];
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      sent.push({ url: String(url), body: String(init?.body || "") });
      return Promise.resolve(new Response(null, { status: 200 }));
    });
    sessionStorage.clear();
    localStorage.clear();
    history.replaceState({}, "", "/users/12345");
    sdk = await import("./index.js");
  });

  afterEach(() => {
    sdk.destroy();
    history.replaceState({}, "", "/");
    vi.restoreAllMocks();
  });

  it("reports different actions for errors either side of setRouteTemplate", () => {
    // Current behaviour: each error reads the route state at its own moment.
    // The first error lands before the host's router effect has run, so it
    // reports the raw pathname, and the second reports the template. Two
    // errors on one page view therefore group as two incidents.
    sdk.init({ key: "k" });

    sdk.captureError(new Error("thrown before the router effect"));
    sdk.setRouteTemplate("/users/:id");
    sdk.captureError(new Error("thrown after the router effect"));

    expect(errorActions()).toEqual(["/users/12345", "/users/:id"]);
  });

  it("reports the template for both errors when the host set it first", () => {
    sdk.init({ key: "k" });
    sdk.setRouteTemplate("/users/:id");

    sdk.captureError(new Error("first"));
    sdk.captureError(new Error("second"));

    expect(errorActions()).toEqual(["/users/:id", "/users/:id"]);
  });
});
