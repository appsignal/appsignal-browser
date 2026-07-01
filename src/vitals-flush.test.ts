import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Capture the web-vitals handlers so we can drive a vital without a browser.
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

import { init, destroy, flush, addBreadcrumb } from "./index.js";

function eventsPayloads(sent: { body: string }[]) {
  return sent
    .map((p) => {
      try {
        return JSON.parse(p.body);
      } catch {
        return null;
      }
    })
    .filter((b) => b?.type === "events");
}

describe("vitals flush model", () => {
  let sent: { url: string; body: string }[] = [];

  beforeEach(() => {
    sent = [];
    vi.useFakeTimers();
    for (const k of Object.keys(handlers)) delete handlers[k];
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      sent.push({ url: String(_url), body: String(init?.body || "") });
      return Promise.resolve(new Response(null, { status: 200 }));
    });
    sessionStorage.clear();
    localStorage.clear();
  });

  afterEach(() => {
    destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("excludes vitals from the periodic timer but ships them on an explicit flush", () => {
    // Enable session streaming so the periodic timer is actually armed (it's a
    // no-op and unarmed by default). The timer ships the breadcrumb journey but
    // must never carry vitals — those leave only at route/page boundaries.
    init({ key: "k", session: { enabled: true } });

    handlers.lcp({ name: "LCP", value: 2000, entries: [{ startTime: 100 }] });
    addBreadcrumb({ category: "test", message: "tick" });

    vi.advanceTimersByTime(30_000);
    const periodic = eventsPayloads(sent);
    // The periodic flush shipped the journey...
    expect(periodic.length).toBeGreaterThan(0);
    // ...but withheld vitals entirely.
    expect(periodic.every((e) => (e.vitals ?? []).length === 0)).toBe(true);

    // An explicit flush (stands in for navigation / page-hide) ships the vital.
    flush();
    const lcp = eventsPayloads(sent)
      .flatMap((e) => e.vitals ?? [])
      .find((v: { name: string }) => v.name === "LCP");
    expect(lcp?.value).toBe(2000);
  });
});
