// SPA navigation flush tests. Cover the contract in index.ts:202-205: when
// the app calls history.pushState, the SDK records a navigation breadcrumb
// and flushes the buffer in the same operation. Ordering is load-bearing —
// initBreadcrumbs registers recordNav first, then startCollection registers
// the flush, so the breadcrumb is already in the buffer by the time the
// flush runs.

import { test, expect } from "../fixtures.js";
import { reset, ingestEvents, pollFor } from "../helpers.js";

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test("pushState records a nav breadcrumb and flushes it in the same payload", async ({ page, request }) => {
  await page.goto("/");
  await page.click("#add-breadcrumb");

  await page.evaluate(() => {
    history.pushState({}, "", "/spa-route-1");
  });

  // Find a single ingest payload that carries both the manual breadcrumb
  // and the nav breadcrumb. If recordNav fired after flushEvents, the nav
  // breadcrumb would sit in the buffer until the next flush (30 s later or
  // on unload) — that's the regression this test guards against.
  const navBreadcrumb = await pollFor(request, (items) =>
    ingestEvents(items).flatMap((e) => {
      const breadcrumbs = (e.breadcrumbs as Array<Record<string, unknown>>) ?? [];
      const hasManual = breadcrumbs.some(
        (b) => b.category === "test" && b.message === "manual breadcrumb",
      );
      if (!hasManual) return [];
      return breadcrumbs.filter((b) => {
        const data = b.data as { to?: string } | undefined;
        return b.category === "navigation" && data?.to?.endsWith("/spa-route-1");
      });
    })[0],
  );

  expect(navBreadcrumb).toMatchObject({
    category: "navigation",
    message: expect.stringMatching(/ → .*\/spa-route-1$/),
    data: {
      to: expect.stringMatching(/\/spa-route-1$/),
    },
  });
});
