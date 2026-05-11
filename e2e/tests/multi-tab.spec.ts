// Multi-tab session sharing. Two tabs in the same browser context share
// localStorage and therefore the session — restoreOrCreateSession in the
// second tab reads the first tab's SESSION_KEY rather than minting a new
// one (session.ts:48-59). tab_id is in *sessionStorage*, not localStorage,
// so each tab carries its own. This is the only behavior here that needs
// a real second BrowsingContext; a unit test with a mocked StorageEvent
// can't reproduce sessionStorage scoping.

import { test, expect } from "../fixtures.js";
import { reset, ingestEvents, pollFor } from "../helpers.js";

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test("two tabs in the same context share session_id but get distinct tab_ids", async ({ page, request }) => {
  await page.goto("/");
  await page.click("#add-breadcrumb");
  await page.evaluate(() =>
    (window as unknown as { AppsignalBrowser: { flush(): void } })
      .AppsignalBrowser.flush(),
  );

  // Wait until tab 1 has written its session id to localStorage. Without
  // this, opening tab 2 immediately can race and produce a second session.
  await page.waitForFunction(
    () => localStorage.getItem("appsignal_session_id") !== null,
  );

  const page2 = await page.context().newPage();
  await page2.goto("/");
  await page2.click("#add-breadcrumb");
  await page2.evaluate(() =>
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

  const sessions = payloads.map(
    (p) => p.session as { session_id: string; tab_id: string },
  );
  const sessionIds = new Set(sessions.map((s) => s.session_id));
  const tabIds = new Set(sessions.map((s) => s.tab_id));

  expect(sessionIds.size).toBe(1);
  expect(tabIds.size).toBe(2);
});
