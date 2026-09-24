// The spans an error sends: the navigation, what the person did, and the
// request before it. These assert on what the ingest server received, because
// the IDs have to match the `traceparent` the browser already sent.

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

/** Wait until the browser has sent `count` traces, then take them all. Each
 * trace root leaves in an envelope of its own. */
async function waitForTraces(
  request: APIRequestContext,
  url: string,
  count: number,
): Promise<OtlpSpan[][]> {
  let posts: OtlpSpan[][] = [];
  await expect
    .poll(async () => {
      posts = await tracePosts(request, url);
      return posts.length;
    }, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(count);
  return posts;
}

/** A button that fetches and then throws, so one click produces a request and
 * the errors that followed it. */
async function addCheckoutButton(page: Page, id: string, path: string, errors: string[]) {
  await page.evaluate(
    ({ id, path, errors }) => {
      const button = document.createElement("button");
      button.id = id;
      button.textContent = id;
      document.body.appendChild(button);
      button.addEventListener("click", () => {
        void fetch(path, { method: "POST", body: "{}" });
        // After the request settles, so its breadcrumb is there to be found.
        errors.forEach((name, index) => {
          setTimeout(() => {
            const error = new Error(`${name} went wrong`);
            error.name = name;
            throw error;
          }, 300 + index * 50);
        });
      });
    },
    { id, path, errors },
  );
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

test("an error with nothing before it hangs off the root alone", async ({
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

  // Nobody clicked, and arriving on the page is not something they did either:
  // the root already names it. The request hangs straight off the root.
  expect(spans.some((span) => span.name.startsWith("click"))).toBe(false);
  expect(spans.some((span) => span.name.startsWith("navigation"))).toBe(false);
  expect(requestSpan?.parentSpanId).toBe(root!.spanId);
  expect(spans).toHaveLength(2);
});

test("two errors after one action describe that action once", async ({
  page,
  request,
  ingestUrl,
}) => {
  await addCheckoutButton(page, "checkout", "/api/prices", ["PriceNaNError", "TaxNaNError"]);

  await page.click("#checkout");
  await page.waitForTimeout(600);
  await page.evaluate(() => (window as unknown as { AppsignalBrowser: { flush(): void } }).AppsignalBrowser.flush());

  const spans = await waitForSpans(request, ingestUrl);

  // Two errors are two errors, not two clicks. A fresh span each time would
  // declare one action twice, under IDs nothing can reconcile.
  expect(spans.filter((span) => span.name.startsWith("click"))).toHaveLength(1);
  expect(spans.filter((span) => attribute(span, "url.path") === "/api/prices")).toHaveLength(1);
  const errored = spans.find((span) => span.events.length > 1);
  expect(errored?.events.map((event) => event.name)).toEqual(["exception", "exception"]);
});

test("each thing the person does gets a trace of its own", async ({
  page,
  request,
  ingestUrl,
}) => {
  await addCheckoutButton(page, "cart", "/api/cart", ["CartLockedError"]);
  await addCheckoutButton(page, "pay", "/api/pay", ["PayTokenError"]);

  await page.click("#cart");
  await page.waitForTimeout(600);
  await page.click("#pay");
  await page.waitForTimeout(600);
  await page.evaluate(() => (window as unknown as { AppsignalBrowser: { flush(): void } }).AppsignalBrowser.flush());

  const posts = await waitForTraces(request, ingestUrl, 2);
  const traceIds = posts.map((spans) => spans[0].traceId);

  // One interaction, one trace: what the person did next is not the same story.
  expect(new Set(traceIds).size).toBe(posts.length);
  expect(posts.some((spans) => requestTo(spans, "/api/cart"))).toBe(true);
  expect(posts.some((spans) => requestTo(spans, "/api/pay"))).toBe(true);
  // Neither trace holds the other's request.
  for (const spans of posts) {
    expect(spans.filter((span) => attribute(span, "url.path"))).toHaveLength(1);
  }
});

test("an error sends the navigation, the action before it, and the request", async ({
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
  const click = spans.find((span) => span.name.startsWith("click"));
  const requestSpan = spans.find((span) => span.name.startsWith("POST"));

  expect(root).toBeDefined();
  expect(click?.parentSpanId).toBe(root!.spanId);
  expect(requestSpan?.parentSpanId).toBe(click!.spanId);
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

test("what the person did gets a trace of its own, without the page's own loading", async ({
  page,
  request,
  ingestUrl,
}) => {

  const booted = await page.evaluate(async () => {
    const sent: string[] = [];
    const original = Headers.prototype.set;
    Headers.prototype.set = function (key: string, value: string) {
      if (key.toLowerCase() === "traceparent") sent.push(value);
      return original.call(this, key, value);
    };
    (window as unknown as { __sent: string[] }).__sent = sent;

    // The page loading itself, before anybody has touched it.
    await fetch("/api/boot").catch(() => {});

    const button = document.createElement("button");
    button.id = "checkout";
    button.textContent = "Checkout";
    document.body.appendChild(button);
    button.addEventListener("click", () => {
      void fetch("/api/prices", { method: "POST", body: "{}" });
      // After the request settles, so its breadcrumb is there to be found.
      setTimeout(() => {
        const error = new Error("total is undefined");
        error.name = "TypeError";
        throw error;
      }, 300);
    });
    return sent[0];
  });

  // A real gesture, not button.click(): only a trusted pointerdown tells the
  // SDK the person acted.
  await page.click("#checkout");
  await page.waitForTimeout(600);
  await page.evaluate(() => (window as unknown as { AppsignalBrowser: { flush(): void } }).AppsignalBrowser.flush());

  const spans = await waitForSpans(request, ingestUrl);
  const root = spans.find((span) => !span.parentSpanId);
  const [, bootTraceId] = booted.split("-");

  // The error's trace holds what the person did. The page's own loading is a
  // trace of its own, and none of it is in this one.
  expect(root!.traceId).not.toBe(bootTraceId);
  expect(requestTo(spans, "/api/prices")).toBeDefined();
  expect(requestTo(spans, "/api/boot")).toBeUndefined();
});

test("an error that beats its request home does not borrow the last one", async ({
  page,
  request,
  ingestUrl,
}) => {
  await addCheckoutButton(page, "cart", "/api/cart", []);
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.id = "pay";
    button.textContent = "Pay";
    document.body.appendChild(button);
    button.addEventListener("click", () => {
      // Never settles, so it records no breadcrumb before the error.
      void fetch("/api/never");
      setTimeout(() => {
        const error = new Error("total is undefined");
        error.name = "TypeError";
        throw error;
      }, 100);
    });
  });

  await page.click("#cart");
  await page.waitForTimeout(400);
  await page.click("#pay");
  await page.waitForTimeout(400);
  await page.evaluate(() => (window as unknown as { AppsignalBrowser: { flush(): void } }).AppsignalBrowser.flush());

  const posts = await waitForTraces(request, ingestUrl, 1);
  const errored = posts.find((spans) => spans.some((span) => span.events.length > 0))!;

  // The settled request belongs to the interaction before this one, and a
  // backend span there already points at its ID.
  expect(requestTo(errored, "/api/cart")).toBeUndefined();
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
