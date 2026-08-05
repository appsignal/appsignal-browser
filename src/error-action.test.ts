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

  it("freezes the action, so errors either side of setRouteTemplate agree", () => {
    // This is the one intended behaviour change in the page load span work, and
    // it is deliberate. The first error freezes the action, so the second
    // reports the same string even though the host declared a template in
    // between. Before the freeze the two reported different actions and grouped
    // as two incidents; now they group as one.
    //
    // Two errors on one page view should group together, so this is the better
    // grouping. It does mean an app that throws before its router effect runs
    // will see two of its existing incidents merge into one.
    sdk.init({ key: "k" });

    sdk.captureError(new Error("thrown before the router effect"));
    sdk.setRouteTemplate("/users/:id");
    sdk.captureError(new Error("thrown after the router effect"));

    expect(errorActions()).toEqual(["/users/12345", "/users/12345"]);
  });

  it("starts a fresh action on the next navigation", () => {
    // The freeze lasts one navigation. Without the reset, every route after the
    // first would report the landing route's action.
    sdk.init({ key: "k" });
    sdk.captureError(new Error("on the landing route"));

    history.pushState({}, "", "/invoices/7");
    sdk.setRouteTemplate("/invoices/:id");
    sdk.captureError(new Error("on the second route"));

    expect(errorActions()).toEqual(["/users/12345", "/invoices/:id"]);
  });

  it("reports the template for both errors when the host set it first", () => {
    sdk.init({ key: "k" });
    sdk.setRouteTemplate("/users/:id");

    sdk.captureError(new Error("first"));
    sdk.captureError(new Error("second"));

    expect(errorActions()).toEqual(["/users/:id", "/users/:id"]);
  });
});
