// The spans an error sends: the page, and the request before the error. These
// assert on what the ingest server received, because the IDs have to match the
// `traceparent` the browser already sent.

import { test, expect, type APIRequestContext, type Page } from "../fixtures.js";
import { withSdkConfig } from "../helpers.js";

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  attributes: { key: string; value: { stringValue?: string; intValue?: string } }[];
  events: { name: string; attributes: { key: string; value: { stringValue?: string } }[] }[];
  status?: { code: number };
}

async function tracePosts(request: APIRequestContext, url: string): Promise<OtlpSpan[][]> {
  const res = await request.get(`${url}/__captured`);
  const items = (await res.json()) as { path: string; body: string }[];
  return items
    .filter((item) => item.path === "/ingest/browser/v1/traces")
    .map((item) => JSON.parse(item.body).resourceSpans[0].scopeSpans[0].spans as OtlpSpan[]);
}

/** Every span ID above this one, so a test can assert a chain without pinning
 * each link in it. */
function ancestors(spans: OtlpSpan[], span: OtlpSpan): string[] {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const seen: string[] = [];
  let current = span.parentSpanId ? byId.get(span.parentSpanId) : undefined;
  while (current && !seen.includes(current.spanId)) {
    seen.push(current.spanId);
    current = current.parentSpanId ? byId.get(current.parentSpanId) : undefined;
  }
  return seen;
}

function attribute(span: OtlpSpan, key: string): string | undefined {
  return span.attributes.find((a) => a.key === key)?.value.stringValue;
}

/** A request span by what it asked for. The HTTP conventions name a client span
 * by its method alone, so the target lives in `url.path`. */
function requestTo(spans: OtlpSpan[], path: string): OtlpSpan | undefined {
  return spans.find((span) => attribute(span, "url.path") === path);
}

/** Wait for the spans of one navigation, which leave on the flush after the
 * first error rather than at the moment it happens. */
async function waitForSpans(request: APIRequestContext, url: string): Promise<OtlpSpan[]> {
  let spans: OtlpSpan[] = [];
  await expect
    .poll(async () => {
      const posts = await tracePosts(request, url);
      spans = posts[0] ?? [];
      return spans.length;
    }, { timeout: 15_000 })
    .toBeGreaterThan(0);
  return spans;
}

test.beforeEach(async ({ page, request, ingestUrl }) => {
  await request.post(`${ingestUrl}/__reset`);
  await withSdkConfig(page, {
    endpoint: ingestUrl,
    tracePropagationTargets: ["**/*"],
    tracing: { endpoint: `${ingestUrl}/ingest/browser`, appName: "App", environment: "test" },
  });
  await page.goto("/");
});

test("an error hangs off the page and the request before it", async ({
  page,
  request,
  ingestUrl,
}) => {

  await page.evaluate(async () => {
    // The page loading itself: a request, and an error, with nobody touching it.
    await fetch("/api/boot").catch(() => {});
    setTimeout(() => {
      const error = new Error("boot data missing");
      error.name = "BootDataError";
      throw error;
    }, 0);
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => (window as unknown as { AppsignalBrowser: { flush(): void } }).AppsignalBrowser.flush());

  const spans = await waitForSpans(request, ingestUrl);
  const root = spans.find((span) => !span.parentSpanId);
  const requestSpan = requestTo(spans, "/api/boot");

  // The page and the request it made, and nothing between them.
  expect(requestSpan?.parentSpanId).toBe(root!.spanId);
  expect(spans).toHaveLength(2);
});

test("the request span follows the HTTP conventions", async ({
  page,
  request,
  ingestUrl,
}) => {

  await page.evaluate(async () => {
    const button = document.createElement("button");
    button.textContent = "Checkout";
    document.body.appendChild(button);
    button.addEventListener("click", () => {
      void fetch("/api/prices", { method: "POST", body: "{}" });
    });
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    setTimeout(() => {
      const error = new Error("total is undefined");
      error.name = "TypeError";
      throw error;
    }, 0);
  });
  await page.evaluate(() => (window as unknown as { AppsignalBrowser: { flush(): void } }).AppsignalBrowser.flush());

  const spans = await waitForSpans(request, ingestUrl);
  const root = spans.find((span) => !span.parentSpanId);
  const requestSpan = spans.find((span) => span.name.startsWith("POST"));

  // CLIENT, not INTERNAL: a trace view reads this to draw the hop to whoever
  // served the request, and the backend spans nest under it.
  expect(requestSpan?.kind).toBe(3);
  expect(root?.kind).toBe(1);
  // Named by method alone, with the target in an attribute: a path carrying an
  // ID would give every request a span name of its own.
  expect(requestSpan?.name).toBe("POST");
  expect(attribute(requestSpan!, "url.path")).toBe("/api/prices");
  // The conventions type this one as an int, and a receiver may hold it to that.
  const status = requestSpan?.attributes.find((a) => a.key === "http.response.status_code");
  expect(status?.value).toEqual({ intValue: "200" });
  // Every span of one navigation shares its trace.
  expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
});

test("the request span carries the ID its traceparent already sent", async ({
  page,
  request,
  ingestUrl,
}) => {

  const sent = await page.evaluate(async () => {
    let header = "";
    const original = Headers.prototype.set;
    Headers.prototype.set = function (key: string, value: string) {
      if (key.toLowerCase() === "traceparent" && !header) header = value;
      return original.call(this, key, value);
    };
    await fetch("/api/prices", { method: "POST", body: "{}" }).catch(() => {});
    Headers.prototype.set = original;
    setTimeout(() => {
      const error = new Error("total is undefined");
      error.name = "TypeError";
      throw error;
    }, 0);
    return header;
  });
  await page.evaluate(() => (window as unknown as { AppsignalBrowser: { flush(): void } }).AppsignalBrowser.flush());

  const [, traceId, spanId] = sent.split("-");
  const spans = await waitForSpans(request, ingestUrl);
  const requestSpan = spans.find((span) => span.name.startsWith("POST"));

  // The backend spans built from that header point at this ID, so it has to
  // survive to the span the browser declares or they nest under nothing.
  expect(requestSpan?.spanId).toBe(spanId);
  expect(requestSpan?.traceId).toBe(traceId);
});

test("the exception rides the span it happened on", async ({
  page,
  request,
  ingestUrl,
}) => {

  await page.evaluate(async () => {
    const button = document.createElement("button");
    button.textContent = "Checkout";
    document.body.appendChild(button);
    button.addEventListener("click", () => {
      void fetch("/api/prices", { method: "POST", body: "{}" });
    });
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    setTimeout(() => {
      const error = new Error("total is undefined");
      error.name = "TypeError";
      throw error;
    }, 0);
  });
  await page.evaluate(() => (window as unknown as { AppsignalBrowser: { flush(): void } }).AppsignalBrowser.flush());

  const spans = await waitForSpans(request, ingestUrl);
  const requestSpan = spans.find((span) => span.name.startsWith("POST"));

  // Not on the navigation: a timeline marks the error where it happened rather
  // than at the page.
  const errored = spans.find((span) => span.events.length > 0);
  expect(errored?.spanId).toBe(requestSpan!.spanId);
  expect(errored?.events[0].name).toBe("exception");
  expect(errored?.status?.code).toBe(2);
});
