// Offline → online recovery. While offline, transport.send sees
// !navigator.onLine and enqueues instead of fetching (transport.ts:124-127).
// When the browser comes back online, the `online` listener fires
// flushOnline → drainQueue → doFetch for every queued payload
// (transport.ts:146-184). Network-flaky users (mobile, transit) hit this
// constantly; a regression would silently drop data they generated while
// disconnected.

import { test, expect } from "../fixtures.js";
import { reset, captured, ingestEvents, pollFor } from "../helpers.js";

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test("events queued while offline drain when the browser comes back online", async ({ page, request }) => {
  await page.goto("/");
  // Wait for init to settle so the offline toggle doesn't race with the
  // initial config GET.
  await page.waitForTimeout(500);

  const ingestPostCount = async (): Promise<number> =>
    (await captured(request)).filter(
      (i) => i.kind === "ingest" && i.path === "/ingest/browser",
    ).length;

  const baseline = await ingestPostCount();

  await page.context().setOffline(true);

  await page.click("#add-breadcrumb");
  await page.evaluate(() =>
    (window as unknown as { AppsignalBrowser: { flush(): void } })
      .AppsignalBrowser.flush(),
  );
  await page.waitForTimeout(500);

  // Offline-window: no POSTs should have landed.
  expect(await ingestPostCount()).toBe(baseline);

  // Restore connectivity — onLine listener fires drainQueue.
  await page.context().setOffline(false);

  const manual = await pollFor(request, (items) =>
    ingestEvents(items)
      .flatMap((e) => (e.breadcrumbs as Array<Record<string, unknown>>) ?? [])
      .find((b) => b.category === "test" && b.message === "manual breadcrumb"),
  );

  expect(manual).toMatchObject({
    category: "test",
    message: "manual breadcrumb",
    data: { from: "e2e" },
  });
});
