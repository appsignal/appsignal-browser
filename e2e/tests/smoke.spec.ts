// Smoke tests for the SDK's real-browser behaviour. Each test resets the
// fixture server's captured state, drives the page, and waits for the
// expected payloads to land at the server.

import { test, expect } from "../fixtures.js";
import {
  reset,
  flush,
  ingestEvents,
  pollFor,
  type CapturedApi,
} from "../helpers.js";

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test("page loads, SDK initialises, no console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
  });

  await page.goto("/");
  await page.waitForFunction(() =>
    typeof (window as unknown as { AppsignalBrowser?: unknown }).AppsignalBrowser !== "undefined",
  );

  expect(errors).toEqual([]);
});

test("network breadcrumb for a 404 shows the status code, not '(error)'", async ({ page, request }) => {
  // Regression for the bug fixed in 6f980b5: non-2xx responses used to
  // surface as "(error)" in the breadcrumb message, hiding the status.
  await page.goto("/");
  await page.click("#trigger-fetch-404");
  await flush(page);

  const breadcrumb = await pollFor(request, (items) =>
    ingestEvents(items)
      .flatMap((e) => (e.breadcrumbs as Array<Record<string, unknown>>) ?? [])
      .find((b) => {
        const msg = b.message as string | undefined;
        return msg?.includes("/api/echo") && (b.data as Record<string, unknown>)?.status === 404;
      }),
  );

  expect(breadcrumb).toMatchObject({
    category: "network",
    message: expect.stringMatching(/GET .*\/api\/echo 404$/),
  });
});

test("tracePropagationTargets injects traceparent and the breadcrumb attaches the same trace_id", async ({ page, request }) => {
  // Two-sided assertion: the test API endpoint sees the traceparent header,
  // and the SDK's network breadcrumb carries data.trace_id matching the
  // header's middle segment. This is the correlation that makes
  // frontend↔backend trace stitching work.
  // Glob matches `host + pathname`, where host includes the port. Use a
  // suffix-style pattern that doesn't pin it.
  await page.goto("/?tracePropagationTargets=" + encodeURIComponent("**/api/**"));
  await page.click("#trigger-fetch");
  await flush(page);

  // Wait until both the API request (with traceparent) and the breadcrumb
  // (with trace_id) have landed. pollFor returns the joined view directly.
  const joined = await pollFor(request, (items) => {
    const api = items.find(
      (i): i is CapturedApi => i.kind === "api" && i.path === "/api/echo",
    );
    const traceparent = api?.headers.traceparent;
    if (!traceparent) return null;

    const networkCrumb = ingestEvents(items)
      .flatMap((e) => (e.breadcrumbs as Array<Record<string, unknown>>) ?? [])
      .find((b) => b.category === "network" && (b.message as string).includes("/api/echo"));
    const traceIdOnBreadcrumb = (networkCrumb?.data as Record<string, unknown> | undefined)
      ?.trace_id as string | undefined;
    if (!traceIdOnBreadcrumb) return null;

    const [, traceIdFromHeader] = traceparent.split("-");
    return { traceparent, traceIdFromHeader, traceIdOnBreadcrumb };
  });

  expect(joined.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  expect(joined.traceIdOnBreadcrumb).toBe(joined.traceIdFromHeader);
});
