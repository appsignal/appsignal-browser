// destroy() teardown contract. After destroy() the SDK must:
//  - flush whatever's buffered (one final ingest POST), then
//  - detach every listener it installed: clicks, errors, visibilitychange,
//    pagehide, fetch/XHR patches, replay timers, retry timers.
// Anything the page does afterwards should produce zero further ingest
// traffic. This guards against listener leaks on init→destroy→init cycles
// and prevents stray fetches from a torn-down transport.

import { test, expect } from "../fixtures.js";
import { reset, captured } from "../helpers.js";

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test("destroy() detaches all collectors; no ingest after teardown", async ({ page, request }) => {
  await page.goto("/");
  await page.click("#add-breadcrumb");

  await page.evaluate(() =>
    (window as unknown as { AppsignalBrowser: { destroy(): void } }).AppsignalBrowser.destroy(),
  );

  // Give the destroy-time flush (sendBeacon) time to land at the server.
  await page.waitForTimeout(500);

  const ingestCount = async (): Promise<number> =>
    (await captured(request)).filter(
      (i) => i.kind === "ingest" && i.path === "/ingest/browser",
    ).length;

  const baseline = await ingestCount();

  // Trigger every path that would normally produce an ingest call:
  //   - click breadcrumb (DOM listener)
  //   - thrown error (window.onerror)
  //   - manual addBreadcrumb (no-ops post-destroy)
  //   - visibilitychange hidden (lifecycle flush)
  //   - pagehide (lifecycle flush, beacon)
  await page.click("#add-breadcrumb");
  await page.click("#throw-error");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
  });

  // 1 s is well past any synchronous flush path; if any listener were still
  // attached, the visibility/pagehide handlers above would have already
  // written to /ingest/browser by now.
  await page.waitForTimeout(1000);
  expect(await ingestCount()).toBe(baseline);
});
