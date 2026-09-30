import { test, expect } from "../fixtures.js";
import { reset, ingestErrors, pollFor, type CapturedApi } from "../helpers.js";

test.beforeEach(async ({ page, request }) => {
  await reset(request);
  await page.goto("/trace-propagation.html");
});

for (const [button, name, status] of [
  ["#trigger-fetch-500", "HTTPError", 500],
  ["#trigger-xhr-503", "HTTPError", 503],
  ["#trigger-timeout", "TimeoutError", undefined],
  ["#trigger-xhr-timeout", "TimeoutError", undefined],
] as const) {
  test(`${button} reports the exact browser parent propagated to the backend`, async ({ page, request }) => {
    await page.click(button);
    const joined = await pollFor(request, items => {
      const api = items.find((item): item is CapturedApi => item.kind === "api" && item.path === "/api/echo");
      const error = ingestErrors(items).find(item => (item.error as { name?: string })?.name === name);
      return api?.headers.traceparent && error ? { api, error } : null;
    });
    const [, trace, span] = joined.api.headers.traceparent!.split("-");
    expect(joined.error).toMatchObject({ trace_id: trace, span_id: span, service_name: "Browser" });
    expect(joined.error.parent_span_id).toBeUndefined();
    const details = (joined.error.params as { request: { status?: number; duration_ms: number } }).request;
    expect(details.status).toBe(status);
    expect(details.duration_ms).toBeGreaterThanOrEqual(0);
    // Milliseconds, so the span keeps the length of a sub-second request.
    const startMs = joined.error.start_time_ms as number;
    expect(startMs).toBeGreaterThan((joined.error.timestamp as number) * 1000 - 60_000);
    expect(joined.error.duration_ms).toBe(details.duration_ms);
  });
}

test("a JS error after a 500 stays independent, and a 404 adds no request error", async ({ page, request }) => {
  await page.click("#trigger-fetch-500");
  await pollFor(request, items => ingestErrors(items).length === 1);
  await page.click("#trigger-fetch-404");
  await expect(page.locator("#status")).toHaveText("fetch resolved with HTTP 404");
  await page.click("#trigger-js-error");
  const errors = await pollFor(request, items => {
    const errors = ingestErrors(items);
    return errors.some(error => (error.error as { message?: string })?.message?.includes("Independent rendering error")) ? errors : null;
  });
  expect(errors).toHaveLength(2);
  const jsError = errors.find(error => (error.error as { name?: string })?.name === "Error")!;
  expect(jsError.trace_id).toBeUndefined();
  expect(jsError.span_id).toBeUndefined();
});

test("an unhandled fetch rejection does not duplicate the request report", async ({ page, request }) => {
  await page.evaluate(() => { void fetch("/api/echo?delay=2000", { signal: AbortSignal.timeout(300) }); });
  await pollFor(request, items => ingestErrors(items).some(error => (error.error as { name?: string })?.name === "TimeoutError"));
  // Cross a browser task boundary after unhandled-rejection delivery, then
  // post a manual error as a positive marker that the error handler ran.
  await page.click("#trigger-js-error");
  const errors = await pollFor(request, items => {
    const errors = ingestErrors(items);
    return errors.some(error => (error.error as { name?: string })?.name === "Error") ? errors : null;
  });
  expect(errors).toHaveLength(2);
  expect(errors.filter(error => (error.error as { name?: string })?.name === "TimeoutError")).toHaveLength(1);
});

test("a request that never reached the backend adds no request error", async ({ page, request }) => {
  await page.click("#trigger-connection-closed");
  await expect(page.locator("#status")).toContainText("fetch rejected");
  await page.click("#trigger-js-error");
  const errors = await pollFor(request, items => {
    const errors = ingestErrors(items);
    return errors.some(error => (error.error as { name?: string })?.name === "Error") ? errors : null;
  });
  expect(errors).toHaveLength(1);
});
