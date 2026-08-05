// One page load is one span in one trace. These tests assert that from both
// sides: the traceparent header the test API endpoint actually received, and
// the identity in the payloads the SDK posted to ingest. Agreement between the
// two is what lets the server put the browser span and the backend spans in one
// trace.

import { test, expect } from "../fixtures.js";
import {
  reset,
  flush,
  ingestErrors,
  ingestEvents,
  ingestPageLoads,
  receivedTraceparents,
  withSdkConfig,
  pollFor,
} from "../helpers.js";

// The basic sample page has the fetch, throw and flush controls this needs, and
// withSdkConfig switches propagation on before any script runs.
const TRACE_CONFIG = { tracePropagationTargets: ["**/api/**"] };

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test("two requests in one page load carry the same traceparent", async ({ page, request }) => {
  await withSdkConfig(page, TRACE_CONFIG);
  await page.goto("/");

  await page.click("#trigger-fetch");
  await page.click("#trigger-fetch");

  const headers = await pollFor(request, (items) => {
    const seen = receivedTraceparents(items);
    return seen.length >= 2 ? seen : null;
  });

  expect(headers[0].traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  expect(headers[1].traceparent).toBe(headers[0].traceparent);
});

test("the page_load post declares the span the traceparent points at", async ({ page, request }) => {
  await withSdkConfig(page, TRACE_CONFIG);
  await page.goto("/");

  await page.click("#trigger-fetch");

  const joined = await pollFor(request, (items) => {
    const header = receivedTraceparents(items)[0];
    const declared = ingestPageLoads(items)[0];
    if (!header || !declared) return null;
    return { header, declared };
  });

  // The span exists under the ID the backend spans will hang off, and it is
  // labelled with an action, so it can be found in a trace list and grouped.
  expect(joined.declared).toMatchObject({
    type: "page_load",
    trace_id: joined.header.trace_id,
    span_id: joined.header.span_id,
    action: "/",
  });
  expect(typeof joined.declared.start_time).toBe("number");
  // No tags were set on this page load, but the field always ships so the
  // server can union it with whatever an error row might carry.
  expect(joined.declared.tags).toEqual({});
});

test("the page_load post carries the host's tags", async ({ page, request }) => {
  await withSdkConfig(page, TRACE_CONFIG);
  await page.goto("/");

  // Previously host tags rode on error payloads only, so a page load had tags
  // only if something threw. They now ship on the declaring post too.
  await page.evaluate(() => {
    (
      window as unknown as { AppsignalBrowser: { setTags(t: Record<string, string>): void } }
    ).AppsignalBrowser.setTags({ plan: "pro" });
  });
  await page.click("#trigger-fetch");

  const declared = await pollFor(request, (items) => ingestPageLoads(items)[0] ?? null);

  expect(declared.tags).toEqual({ plan: "pro" });
});

test("the page_load post carries the host's app_version", async ({ page, request }) => {
  await withSdkConfig(page, { ...TRACE_CONFIG, appVersion: "1.2.3" });
  await page.goto("/");

  await page.click("#trigger-fetch");

  const declared = await pollFor(request, (items) => ingestPageLoads(items)[0] ?? null);

  expect(declared.app_version).toBe("1.2.3");
});

test("an optional service name rides every payload describing the span", async ({
  page,
  request,
}) => {
  await withSdkConfig(page, { ...TRACE_CONFIG, serviceName: "checkout" });
  await page.goto("/");

  await page.click("#trigger-fetch");
  await page.click("#throw-error");
  await flush(page);

  const joined = await pollFor(request, (items) => {
    const declared = ingestPageLoads(items)[0];
    const closing = ingestEvents(items)
      .map((e) => e.page_load as Record<string, unknown> | undefined)
      .find((p) => !!p);
    const error = ingestErrors(items).find(
      (e) => typeof e.message === "string" && e.message.includes("e2e thrown error"),
    );
    if (!declared || !closing || !error) return null;
    return { declared, closing, error };
  });

  // The override is all-or-nothing: every payload describing the span sends
  // the same value, or the rows would disagree about the span's identity.
  expect(joined.declared.service_name).toBe("checkout");
  expect(joined.closing.service_name).toBe("checkout");
  expect(joined.error.service_name).toBe("checkout");
});

test("an error carries the same trace and span as the traceparent", async ({ page, request }) => {
  await withSdkConfig(page, TRACE_CONFIG);
  await page.goto("/");

  await page.click("#trigger-fetch");
  await page.click("#throw-error");

  const joined = await pollFor(request, (items) => {
    const header = receivedTraceparents(items)[0];
    const declared = ingestPageLoads(items)[0];
    // Chromium prefixes an uncaught throw's message, so match on a substring.
    const error = ingestErrors(items).find(
      (e) => typeof e.message === "string" && e.message.includes("e2e thrown error"),
    );
    if (!header || !declared || !error) return null;
    return { header, declared, error };
  });

  // This is what makes the error row and the page load row merge server side
  // into one span rather than rendering as two.
  expect(joined.error.trace_id).toBe(joined.header.trace_id);
  expect(joined.error.span_id).toBe(joined.header.span_id);
  // And they agree on the action, because the first of them to send it froze it.
  expect(joined.error.action).toBe(joined.declared.action);
  // The error also states the navigation's real start rather than its own
  // moment, so the row's interval genuinely belongs to the span instead of
  // stretching it to whenever the error happened.
  expect(joined.error.start_time).toBe(joined.declared.start_time);
});

test("the events post closes the span it declared", async ({ page, request }) => {
  await withSdkConfig(page, TRACE_CONFIG);
  await page.goto("/");

  await page.click("#trigger-fetch");
  await flush(page);

  const joined = await pollFor(request, (items) => {
    const header = receivedTraceparents(items)[0];
    const declared = ingestPageLoads(items)[0];
    const closing = ingestEvents(items)
      .map((e) => e.page_load as Record<string, unknown> | undefined)
      .find((p) => !!p);
    if (!header || !declared || !closing) return null;
    return { header, declared, closing };
  });

  expect(joined.closing.trace_id).toBe(joined.header.trace_id);
  expect(joined.closing.span_id).toBe(joined.header.span_id);
  expect(typeof joined.closing.end_time).toBe("number");
  // The closing object now repeats the action and start time the declaring
  // post already sent. Both used to be left off deliberately, on the theory
  // that only one payload should ever set them — but the freeze already
  // guarantees every payload for one navigation agrees, so a lost page_load
  // post used to leave a span with an end time and no action at all.
  expect(joined.closing.action).toBe(joined.declared.action);
  expect(joined.closing.start_time).toBe(joined.declared.start_time);
});

test("a route change starts a new trace", async ({ page, request }) => {
  await withSdkConfig(page, TRACE_CONFIG);
  await page.goto("/");

  await page.click("#trigger-fetch");
  await page.evaluate(() => {
    history.pushState({}, "", "/spa-route-1");
  });
  await page.click("#trigger-fetch");
  await flush(page);

  const joined = await pollFor(request, (items) => {
    const headers = receivedTraceparents(items);
    const declared = ingestPageLoads(items);
    if (headers.length < 2 || declared.length < 2) return null;
    return { headers, declared };
  });

  // Without the reset the whole visit would be one ever-growing trace.
  expect(joined.headers[1].traceparent).not.toBe(joined.headers[0].traceparent);
  expect(joined.declared[1].span_id).not.toBe(joined.declared[0].span_id);
  // The second navigation's action is the route it is on, not the landing one.
  expect(joined.declared[0].action).toBe("/");
  expect(joined.declared[1].action).toBe("/spa-route-1");

  // Each navigation's boundary post closes its own span.
  const closing = await pollFor(request, (items) => {
    const spans = ingestEvents(items)
      .map((e) => e.page_load as { span_id?: string } | undefined)
      .filter((p): p is { span_id: string } => !!p?.span_id)
      .map((p) => p.span_id);
    return new Set(spans).size >= 2 ? spans : null;
  });
  expect(new Set(closing)).toEqual(
    new Set([joined.declared[0].span_id, joined.declared[1].span_id]),
  );
});
