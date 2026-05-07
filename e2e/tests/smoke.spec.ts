// Smoke tests for the SDK's real-browser behaviour. Each test resets the
// fixture server's captured state, drives the page, and waits for the
// expected payloads to land at the server (poll on /__captured).

import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

interface CapturedIngest {
  kind: "ingest";
  path: string;
  query: Record<string, string>;
  body: string;
  receivedAt: number;
}
interface CapturedApi {
  kind: "api";
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | undefined>;
  body: string;
  receivedAt: number;
}
type Captured = CapturedIngest | CapturedApi;

async function reset(request: APIRequestContext): Promise<void> {
  await request.post("/__reset");
}

async function captured(request: APIRequestContext): Promise<Captured[]> {
  const r = await request.get("/__captured");
  return (await r.json()) as Captured[];
}

function ingestEvents(items: Captured[]): Array<Record<string, unknown>> {
  return items
    .filter((i): i is CapturedIngest => i.kind === "ingest")
    .map((i) => {
      try { return JSON.parse(i.body) as Record<string, unknown>; } catch { return null; }
    })
    .filter((b): b is Record<string, unknown> => b !== null && b.type === "events");
}

// Force a flush via the SDK's flush() API, after waiting long enough for any
// in-flight network-breadcrumb async work to settle. recordNetworkBreadcrumb
// awaits the response body and (up to) a 150 ms resource-timing settle
// before the breadcrumb actually lands in the buffer; 500 ms covers both
// with margin for Playwright IPC latency.
async function flush(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 500));
    (window as unknown as { AppsignalBrowser: { flush(): void } }).AppsignalBrowser.flush();
  });
}

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

  await expect.poll(async () => {
    const breadcrumbs = ingestEvents(await captured(request))
      .flatMap((e) => (e.breadcrumbs as Array<Record<string, unknown>>) ?? []);
    return breadcrumbs.find((b) => {
      const msg = b.message as string | undefined;
      return msg?.includes("/api/echo") && (b.data as Record<string, unknown>)?.status === 404;
    });
  }, { timeout: 5_000 }).toMatchObject({
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

  // Wait for both the API request (with header) and the breadcrumb to land.
  await expect.poll(async () => {
    const items = await captured(request);
    const api = items.find((i): i is CapturedApi => i.kind === "api" && i.path === "/api/echo");
    const traceparent = api?.headers.traceparent;
    if (!traceparent) return null;

    const [, traceIdFromHeader] = traceparent.split("-");
    const breadcrumbs = ingestEvents(items)
      .flatMap((e) => (e.breadcrumbs as Array<Record<string, unknown>>) ?? []);
    const networkCrumb = breadcrumbs.find(
      (b) => b.category === "network" && (b.message as string).includes("/api/echo"),
    );
    const traceIdOnBreadcrumb = (networkCrumb?.data as Record<string, unknown> | undefined)
      ?.trace_id as string | undefined;

    return {
      headerTraceparent: traceparent,
      traceIdFromHeader,
      traceIdOnBreadcrumb,
    };
  }, { timeout: 5_000 }).toEqual(
    expect.objectContaining({
      headerTraceparent: expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/),
      traceIdFromHeader: expect.any(String),
      traceIdOnBreadcrumb: expect.any(String),
    }),
  );

  // And the two trace IDs match.
  const items = await captured(request);
  const api = items.find((i): i is CapturedApi => i.kind === "api" && i.path === "/api/echo")!;
  const headerTraceId = api.headers.traceparent!.split("-")[1];
  const breadcrumb = ingestEvents(items)
    .flatMap((e) => (e.breadcrumbs as Array<Record<string, unknown>>) ?? [])
    .find((b) => b.category === "network" && (b.message as string).includes("/api/echo"))!;
  expect((breadcrumb.data as Record<string, unknown>).trace_id).toBe(headerTraceId);
});
