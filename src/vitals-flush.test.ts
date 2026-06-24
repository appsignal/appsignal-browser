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

import { init, destroy, flush } from "./index.js";

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

  it("does not ship vitals on the periodic timer, but ships them on an explicit flush", () => {
    // session streaming is off by default, so the only thing the periodic
    // timer could ship is vitals.
    init({ key: "k" });

    // A load metric (LCP) is collected but not yet flushed.
    handlers.lcp({ name: "LCP", value: 2000, entries: [{ startTime: 100 }] });

    // Periodic flush fires — vitals must be withheld (no events POST at all,
    // since breadcrumbs are off too).
    vi.advanceTimersByTime(30_000);
    expect(eventsPayloads(sent)).toHaveLength(0);

    // An explicit flush (stands in for navigation / page-hide) ships the vital.
    flush();
    const events = eventsPayloads(sent);
    expect(events).toHaveLength(1);
    expect(events[0].vitals.find((v: { name: string }) => v.name === "LCP")?.value).toBe(2000);
  });
});
