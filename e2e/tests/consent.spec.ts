// Runtime consent transitions. The gates live at three layers:
//  - addBreadcrumb (breadcrumbs.ts:122) drops new crumbs while denied,
//  - flushEvents (index.ts:245) bails before serialising, and
//  - transport send/sendBeacon (transport.ts:101/118) bail before fetch.
// Any one of these missing would leak data after the user has revoked
// consent, so this test exercises all three by driving real activity
// across a deny→grant cycle.

import { test, expect } from "../fixtures.js";
import { reset, captured, ingestEvents, pollFor } from "../helpers.js";

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test("setConsent('not-granted') blocks ingest; setConsent('granted') resumes it", async ({ page, request }) => {
  await page.goto("/");

  // Let init-time traffic (config GET, first replay chunk) settle before
  // we snapshot baselines.
  await page.waitForTimeout(500);

  const ingestCount = async (): Promise<number> =>
    (await captured(request)).filter(
      (i) => i.kind === "ingest" && i.path === "/ingest/browser",
    ).length;

  // ── Deny ────────────────────────────────────────────────────────────
  await page.evaluate(() =>
    (window as unknown as { AppsignalBrowser: { setConsent(s: string): void } })
      .AppsignalBrowser.setConsent("not-granted"),
  );

  const denyBaseline = await ingestCount();

  // Drive every collector that would normally produce ingest traffic:
  // manual breadcrumb (gated at addBreadcrumb), instrumented fetch
  // (network breadcrumb gated at flush), and a forced flush (gated at
  // flushEvents and again at transport.send).
  await page.click("#add-breadcrumb");
  await page.click("#trigger-fetch");
  await page.evaluate(() =>
    (window as unknown as { AppsignalBrowser: { flush(): void } })
      .AppsignalBrowser.flush(),
  );
  await page.waitForTimeout(500);

  expect(await ingestCount()).toBe(denyBaseline);

  // ── Re-grant ────────────────────────────────────────────────────────
  await page.evaluate(() =>
    (window as unknown as { AppsignalBrowser: { setConsent(s: string): void } })
      .AppsignalBrowser.setConsent("granted"),
  );

  await page.click("#add-breadcrumb");
  await page.evaluate(() =>
    (window as unknown as { AppsignalBrowser: { flush(): void } })
      .AppsignalBrowser.flush(),
  );

  // The deny-window click was rejected at addBreadcrumb, so this is the
  // first manual breadcrumb to land — finding it proves both that the gate
  // re-opens and that we're not seeing leftover queued data from the
  // denied period.
  const manual = await pollFor(request, (items) =>
    ingestEvents(items)
      .flatMap((e) => (e.breadcrumbs as Array<Record<string, unknown>>) ?? [])
      .find((b) => b.category === "test" && b.message === "manual breadcrumb"),
  );

  expect(manual).toBeTruthy();
});
