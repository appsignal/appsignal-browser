// session_id persists across page reload via localStorage. The most basic
// session feature: a user visiting page A then page B (via reload, not
// SPA nav) must look like one session, not two. The persistence path goes
// through restoreOrCreateSession (session.ts:48-59) which reads the
// stored id + last-activity and adopts the session if it's still within
// the inactivity window.

import { test, expect } from "../fixtures.js";
import { reset, ingestEvents, pollFor } from "../helpers.js";

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test("session_id is the same before and after a reload", async ({ page, request }) => {
  await page.goto("/");
  await page.click("#add-breadcrumb");
  await page.evaluate(() =>
    (window as unknown as { AppsignalBrowser: { flush(): void } })
      .AppsignalBrowser.flush(),
  );

  // Wait for the first manual-breadcrumb payload to land before reloading
  // so we have a stable pre-reload session_id to compare against.
  await pollFor(request, (items) =>
    ingestEvents(items).find((e) => {
      const crumbs = (e.breadcrumbs as Array<Record<string, unknown>>) ?? [];
      return crumbs.some(
        (c) => c.category === "test" && c.message === "manual breadcrumb",
      );
    }),
  );

  await page.reload();
  await page.click("#add-breadcrumb");
  await page.evaluate(() =>
    (window as unknown as { AppsignalBrowser: { flush(): void } })
      .AppsignalBrowser.flush(),
  );

  const payloads = await pollFor(request, (items) => {
    const withManual = ingestEvents(items).filter((e) => {
      const crumbs = (e.breadcrumbs as Array<Record<string, unknown>>) ?? [];
      return crumbs.some(
        (c) => c.category === "test" && c.message === "manual breadcrumb",
      );
    });
    return withManual.length >= 2 ? withManual : null;
  });

  const sessionIds = payloads.map(
    (p) => (p.session as { session_id: string }).session_id,
  );
  expect(new Set(sessionIds).size).toBe(1);
});
