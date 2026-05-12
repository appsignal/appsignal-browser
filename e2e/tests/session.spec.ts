// endSession() contract. The explicit logout path: flush whatever's buffered
// under the *current* session_id, then clear session state so the next
// captured event lazily mints a fresh session. The flush ordering is
// load-bearing (see index.ts:68-84) — a careless reorder would attribute
// the pre-logout events to the new session, breaking downstream session
// scoping.

import { test, expect } from "../fixtures.js";
import { reset, ingestEvents, pollFor } from "../helpers.js";

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test("endSession flushes under the current session_id, then rotates", async ({ page, request }) => {
  await page.goto("/");
  await page.click("#add-breadcrumb");

  // endSession() flushes pending events via sendBeacon under the existing
  // session_id, clears state, then returns. The next captured activity
  // lazily mints a new session.
  await page.evaluate(() =>
    (window as unknown as { AppsignalBrowser: { endSession(): void } })
      .AppsignalBrowser.endSession(),
  );

  // Wait for the beacon-driven flush to land before producing the post-end
  // activity, so the two manual breadcrumbs don't accidentally share a
  // payload.
  await page.waitForTimeout(500);

  await page.click("#add-breadcrumb");
  await page.evaluate(() =>
    (window as unknown as { AppsignalBrowser: { flush(): void } })
      .AppsignalBrowser.flush(),
  );

  // Collect every events payload that carries a manual breadcrumb. We need
  // at least two — one before endSession (the beacon flush), one after
  // (the explicit flush) — and the session_ids on those payloads must
  // differ.
  const payloads = await pollFor(request, (items) => {
    const withManual = ingestEvents(items).filter((e) => {
      const breadcrumbs = (e.breadcrumbs as Array<Record<string, unknown>>) ?? [];
      return breadcrumbs.some(
        (b) => b.category === "test" && b.message === "manual breadcrumb",
      );
    });
    return withManual.length >= 2 ? withManual : null;
  });

  const sessionIds = payloads.map(
    (p) => (p.session as { session_id: string }).session_id,
  );
  expect(new Set(sessionIds).size).toBeGreaterThanOrEqual(2);
});
