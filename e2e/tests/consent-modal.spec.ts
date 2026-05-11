// Realistic consent-modal flow. SDK initialises with trackingConsent:
// "pending"; every transport.send call enqueues (transport.ts:124-127) until
// the user decides. Accept fires onConsentGranted → drainQueue
// (transport.ts:40-43) which dispatches the queued payloads. Decline fires
// onConsentDenied which empties the queue (transport.ts:45-48). Without
// this spec, a regression in drainQueue would silently drop the first-page
// breadcrumbs/replay for any GDPR-style consent UI.

import { test, expect } from "../fixtures.js";
import { reset, captured, ingestEvents, pollFor } from "../helpers.js";

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test("pending consent buffers traffic; Accept drains the queue", async ({ page, request }) => {
  await page.goto("/consent-modal.html");

  // Activity during pending: addBreadcrumb pushes to the buffer (gated only
  // at "not-granted"); flush builds the events payload and hands it to
  // transport.send, which enqueues because consent is "pending".
  await page.click("#add-breadcrumb");
  await page.click("#flush");

  await page.waitForTimeout(500);
  const before = (await captured(request)).filter(
    (i) => i.kind === "ingest" && i.path === "/ingest/browser",
  );
  expect(before).toHaveLength(0);

  // Accept drains the queue.
  await page.click("#accept");

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

test("pending consent + Decline drops the queued data without sending", async ({ page, request }) => {
  await page.goto("/consent-modal.html");

  await page.click("#add-breadcrumb");
  await page.click("#flush");
  await page.waitForTimeout(300);

  await page.click("#decline");

  // 800 ms is well past any synchronous drain path; if the decline branch
  // accidentally drained instead of clearing, the payload would have
  // landed by now.
  await page.waitForTimeout(800);

  const ingestPosts = (await captured(request)).filter(
    (i) => i.kind === "ingest" && i.path === "/ingest/browser",
  );
  expect(ingestPosts).toHaveLength(0);
});
