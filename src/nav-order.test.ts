import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The SDK's route-boundary handler runs flushEvents() and then
// markVitalsNavigation(), and it runs both from onAfterNavigation — after the
// history method has already changed the URL. Everything that has to be
// captured at route start rather than read at send time depends on that
// ordering, so pin it directly instead of inferring it from a vital's
// page_url.

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

// Wrap the two vitals entry points the boundary handler calls, recording the
// call order and the pathname visible at each call. The rest of the module is
// the real implementation, so the handler behaves exactly as it does in
// production.
const { navLog } = vi.hoisted(() => ({
  navLog: [] as { name: string; pathname: string }[],
}));
vi.mock("./vitals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./vitals.js")>();
  return {
    ...actual,
    // finalizeRouteVitals is the first thing flushEvents does, so it stands in
    // for "the flush ran".
    finalizeRouteVitals: () => {
      navLog.push({ name: "flushEvents", pathname: location.pathname });
      return actual.finalizeRouteVitals();
    },
    markVitalsNavigation: () => {
      navLog.push({ name: "markVitalsNavigation", pathname: location.pathname });
      return actual.markVitalsNavigation();
    },
  };
});

type SdkModule = typeof import("./index.js");
type BreadcrumbsModule = typeof import("./breadcrumbs.js");

describe("route boundary ordering", () => {
  let sdk: SdkModule;
  let breadcrumbs: BreadcrumbsModule;

  beforeEach(async () => {
    navLog.length = 0;
    vi.resetModules();
    for (const k of Object.keys(handlers)) delete handlers[k];
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    );
    sessionStorage.clear();
    localStorage.clear();
    history.replaceState({}, "", "/orders");
    sdk = await import("./index.js");
    breadcrumbs = await import("./breadcrumbs.js");
  });

  afterEach(() => {
    sdk.destroy();
    history.replaceState({}, "", "/");
    vi.restoreAllMocks();
  });

  it("flushes before marking the navigation, with the URL already advanced", () => {
    sdk.init({ key: "k" });
    navLog.length = 0;

    history.pushState({}, "", "/invoices");

    // The flush comes first, and both calls already see the incoming route.
    // That is why a value the outgoing route needs — its page_url today, its
    // action next — has to be captured when the route starts.
    expect(navLog).toEqual([
      { name: "flushEvents", pathname: "/invoices" },
      { name: "markVitalsNavigation", pathname: "/invoices" },
    ]);
  });

  it("runs the route boundary on the after-navigation hook, not the before one", () => {
    sdk.init({ key: "k" });

    // The navigation hook fires its before-listeners with the old URL still in
    // place and its after-listeners with the new one. The route boundary is on
    // the after side, which is what makes the URL already wrong for the route
    // being flushed.
    const seen: { phase: string; pathname: string }[] = [];
    breadcrumbs.onBeforeNavigation(() =>
      seen.push({ phase: "before", pathname: location.pathname }),
    );
    breadcrumbs.onAfterNavigation(() =>
      seen.push({ phase: "after", pathname: location.pathname }),
    );

    history.pushState({}, "", "/invoices");

    expect(seen).toEqual([
      { phase: "before", pathname: "/orders" },
      { phase: "after", pathname: "/invoices" },
    ]);
  });
});
