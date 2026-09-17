// Delivery to an ingest origin other than the page's, which is what every real
// install looks like. The rest of the suite is same-origin and so cannot see a
// beacon that a credentialed CORS check rejects. These assert on what the ingest
// server received, because the faults here are browser behaviour.

import { test, expect, type APIRequestContext } from "../fixtures.js";
import { withSdkConfig } from "../helpers.js";

type Ingest = { kind: string; path: string; body: string };

async function ingestCaptures(
  request: APIRequestContext,
  ingestUrl: string,
): Promise<Ingest[]> {
  const response = await request.get(`${ingestUrl}/__captured`);
  return (await response.json()) as Ingest[];
}

/** The error payloads the ingest origin received, newest last. */
async function errorPayloads(
  request: APIRequestContext,
  ingestUrl: string,
): Promise<Record<string, unknown>[]> {
  const items = await ingestCaptures(request, ingestUrl);
  return items
    .filter((i) => i.path === "/ingest/browser/errors")
    .map((i) => JSON.parse(i.body) as Record<string, unknown>);
}

type Breadcrumb = { category: string; message?: string; metadata?: Record<string, unknown> };

function networkBreadcrumbs(payload: Record<string, unknown>): Breadcrumb[] {
  const breadcrumbs = (payload.breadcrumbs ?? []) as Breadcrumb[];
  return breadcrumbs.filter((breadcrumb) => breadcrumb.category === "network");
}

test.beforeEach(async ({ request, ingestUrl }) => {
  await request.post(`${ingestUrl}/__reset`);
});

test("an error from a hidden tab reaches a cross-origin ingest", async ({
  page,
  request,
  ingestUrl,
}) => {
  await withSdkConfig(page, { endpoint: ingestUrl });
  await page.goto("/");

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    setTimeout(() => {
      const error = new Error("hidden tab error");
      error.name = "HiddenTabError";
      throw error;
    }, 0);
  });

  await expect
    .poll(async () => {
      const payloads = await errorPayloads(request, ingestUrl);
      return payloads.some((p) => (p.error as { name?: string })?.name === "HiddenTabError");
    }, { timeout: 10_000 })
    .toBe(true);
});

test("an error from a response handler carries the request that caused it", async ({
  page,
  request,
  ingestUrl,
}) => {
  await withSdkConfig(page, { endpoint: ingestUrl, tracePropagationTargets: ["**/*"] });
  await page.goto("/");

  await page.evaluate(async () => {
    const response = await fetch("/api/echo", { method: "POST", body: "{}" });
    setTimeout(() => {
      const error = new Error(`request failed ${response.status}`);
      error.name = "HandlerError";
      throw error;
    }, 0);
  });

  const payload = await pollForError(request, ingestUrl, "HandlerError");
  const breadcrumb = networkBreadcrumbs(payload).find((breadcrumb) =>
    String(breadcrumb.metadata?.url ?? "").includes("/api/echo"),
  );

  expect(breadcrumb).toBeDefined();
  expect(breadcrumb?.metadata?.trace_id).toEqual(expect.any(String));
});

test("a cancelled fetch is not reported as a failed request", async ({
  page,
  request,
  ingestUrl,
}) => {
  await withSdkConfig(page, { endpoint: ingestUrl });
  await page.goto("/");

  await page.evaluate(async () => {
    const controller = new AbortController();
    const pending = fetch("/api/echo?delay=3000", { signal: controller.signal }).catch(() => {});
    controller.abort();
    await pending;
    setTimeout(() => {
      const error = new Error("after the cancel");
      error.name = "AfterFetchCancel";
      throw error;
    }, 0);
  });

  const payload = await pollForError(request, ingestUrl, "AfterFetchCancel");
  const failures = networkBreadcrumbs(payload).filter((breadcrumb) => breadcrumb.metadata?.error === true);

  expect(failures).toHaveLength(0);
});

test("a cancelled XHR keeps the breadcrumb of the request that finished", async ({
  page,
  request,
  ingestUrl,
}) => {
  // One object, one finished request then a cancelled one.
  await withSdkConfig(page, { endpoint: ingestUrl, tracePropagationTargets: ["**/*"] });
  await page.goto("/");

  await page.evaluate(async () => {
    const xhr = new XMLHttpRequest();
    await new Promise<void>((done) => {
      xhr.open("GET", "/api/finished");
      xhr.addEventListener("load", () => done());
      xhr.send();
    });

    xhr.open("GET", "/api/cancelled?delay=3000");
    xhr.send();
    xhr.abort();

    await new Promise((r) => setTimeout(r, 100));
    setTimeout(() => {
      const error = new Error("after the xhr cancel");
      error.name = "AfterXhrCancel";
      throw error;
    }, 0);
  });

  const payload = await pollForError(request, ingestUrl, "AfterXhrCancel");
  const breadcrumbs = networkBreadcrumbs(payload);

  // The SDK scrubs query parameters, so match on the path.
  expect(breadcrumbs.find((breadcrumb) => String(breadcrumb.metadata?.url ?? "").includes("/api/finished"))).toBeDefined();
  expect(breadcrumbs.find((breadcrumb) => String(breadcrumb.metadata?.url ?? "").includes("/api/cancelled"))).toBeUndefined();
  expect(breadcrumbs.filter((breadcrumb) => breadcrumb.metadata?.error === true)).toHaveLength(0);
});

async function pollForError(
  request: APIRequestContext,
  ingestUrl: string,
  name: string,
): Promise<Record<string, unknown>> {
  let found: Record<string, unknown> | undefined;
  await expect
    .poll(async () => {
      const payloads = await errorPayloads(request, ingestUrl);
      found = payloads.find((p) => (p.error as { name?: string })?.name === name);
      return Boolean(found);
    }, { timeout: 10_000 })
    .toBe(true);
  return found as Record<string, unknown>;
}
