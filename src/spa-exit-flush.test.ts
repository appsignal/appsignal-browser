import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Capture web-vitals handlers so we can drive a vital without a real browser.
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

import { init, destroy } from "./index.js";

// jsdom's Blob may lack .text(); polyfill so the sendBeacon mock can read bodies.
if (typeof Blob.prototype.text !== "function") {
  Blob.prototype.text = function () {
    return new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsText(this as unknown as Blob);
    });
  };
}

describe("SPA exit flush", () => {
  let sent: { url: string; body: string }[] = [];

  beforeEach(() => {
    sent = [];
    for (const k of Object.keys(handlers)) delete handlers[k];
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      sent.push({ url: String(url), body: String(init?.body || "") });
      return Promise.resolve(new Response(null, { status: 200 }));
    });
    (navigator as unknown as { sendBeacon: (url: string, blob: Blob) => boolean }).sendBeacon = (
      url,
      blob,
    ) => {
      blob.text().then((b) => sent.push({ url, body: b }));
      return true;
    };
    sessionStorage.clear();
    localStorage.clear();
    Object.defineProperty(window, "location", {
      value: new URL("https://example.com/c"),
      configurable: true,
    });
  });

  afterEach(() => {
    destroy();
    vi.restoreAllMocks();
  });

  it("beacons the last route's web vitals on pagehide", async () => {
    init({ key: "k" });

    // A web vital measured on the final route /c, not yet flushed.
    handlers.lcp({ name: "LCP", value: 2000 });

    // User leaves the page — no subsequent navigation to flush /c.
    window.dispatchEvent(new Event("pagehide"));
    await new Promise((r) => setTimeout(r, 0)); // let blob.text() resolve

    const events = sent
      .filter((p) => p.url.includes("/ingest/browser") && !p.url.includes("/errors"))
      .map((p) => {
        try {
          return JSON.parse(p.body);
        } catch {
          return null;
        }
      })
      .filter((b) => b?.type === "events");

    expect(events.length).toBeGreaterThan(0);
    const vitals = events.flatMap((e) => e.vitals ?? []);
    expect(vitals.find((v: { name: string }) => v.name === "LCP")?.value).toBe(2000);
  });
});
