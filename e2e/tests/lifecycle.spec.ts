// Lifecycle flush tests. Cover the visibilitychange/pagehide flush paths in
// index.ts:189-199 — the SDK drains buffered breadcrumbs/vitals via sendBeacon
// when the tab becomes hidden or unloads, except when the page is being put
// into bfcache (persisted=true), where the page is still alive and a flush
// would lose data on restore.

import { test, expect } from "../fixtures.js";
import { reset, captured, ingestEvents, pollFor } from "../helpers.js";

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test("visibilitychange to hidden flushes pending events", async ({ page, request }) => {
  await page.goto("/");
  await page.click("#add-breadcrumb");

  // The SDK's lifecycle handler reads document.visibilityState directly, so
  // the property has to actually return "hidden" when the handler runs —
  // dispatching the event alone isn't enough.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });

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

test("pagehide flushes pending events when not bfcached", async ({ page, request }) => {
  await page.goto("/");
  await page.click("#add-breadcrumb");

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
  });

  const manual = await pollFor(request, (items) =>
    ingestEvents(items)
      .flatMap((e) => (e.breadcrumbs as Array<Record<string, unknown>>) ?? [])
      .find((b) => b.category === "test" && b.message === "manual breadcrumb"),
  );

  expect(manual).toBeTruthy();
});

test("pagehide with persisted=true (bfcache) does not flush", async ({ page, request }) => {
  // bfcache restore keeps the SDK alive; flushing on persisted=true would
  // drop everything buffered before the user returns. The flag in
  // index.ts:196-198 guards exactly this case.
  await page.goto("/");
  await page.click("#add-breadcrumb");

  // Let init-time activity settle before the baseline snapshot.
  await page.waitForTimeout(300);
  const before = ingestEvents(await captured(request)).length;

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
  });

  // The next scheduled flush is 30 s away, so 1 s with no new events ingest
  // means persisted=true was honoured.
  await page.waitForTimeout(1000);
  const after = ingestEvents(await captured(request)).length;

  expect(after).toBe(before);
});
