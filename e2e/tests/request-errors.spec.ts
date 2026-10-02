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

test("reports a 500 the host retried on the same XHR", async ({ page, request }) => {
  await page.click("#trigger-xhr-retry");
  await expect(page.locator("#status")).toHaveText("XHR retried on the same object");
  const joined = await pollFor(request, items => {
    const api = items.find((item): item is CapturedApi =>
      item.kind === "api" && item.path === "/api/echo" && item.method === "POST");
    const error = ingestErrors(items).find(item => (item.error as { name?: string })?.name === "HTTPError");
    return api?.headers.traceparent && error ? { api, error } : null;
  });
  const [, trace, span] = joined.api.headers.traceparent!.split("-");
  expect(joined.error).toMatchObject({ trace_id: trace, span_id: span });
});

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


test("preserves a timeout when an early DONE handler retries the XHR", async ({ page, request }) => {
  await page.evaluate(() => new Promise<void>(resolve => {
    const xhr = new XMLHttpRequest();
    let retried = false;
    xhr.onreadystatechange = () => {
      if (xhr.readyState !== 4) return;
      if (retried) { resolve(); return; }
      retried = true;
      xhr.open("GET", "/api/echo?status=200");
      xhr.timeout = 0;
      xhr.send();
    };
    xhr.open("GET", "/api/echo?delay=2000");
    xhr.timeout = 100;
    xhr.send();
  }));
  const joined = await pollFor(request, items => {
    const api = items.find((item): item is CapturedApi => item.kind === "api" && item.path === "/api/echo");
    const errors = ingestErrors(items);
    return api?.headers.traceparent && errors.length ? { api, errors } : null;
  });
  const [, trace, span] = joined.api.headers.traceparent!.split("-");
  expect(joined.errors).toHaveLength(1);
  expect(joined.errors[0]).toMatchObject({ trace_id: trace, span_id: span, error: { name: "TimeoutError" } });
});

test("only reports identities actually propagated by fetch and XHR", async ({ page, request }) => {
  await page.evaluate(async () => {
    await fetch("/api/echo?status=500", { headers: { traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}` } });
    await new Promise<void>(resolve => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/echo?status=500");
      xhr.setRequestHeader("traceparent", "invalid");
      xhr.onload = () => resolve();
      xhr.send();
    });
    // A positive marker confirms the preceding XHR report path has finished.
    (window as any).AppsignalBrowser.captureError(new Error("header-check-finished"));
  });
  const items = await pollFor(request, items => ingestErrors(items).some(e =>
    (e.error as { message?: string })?.message === "header-check-finished") ? items : null);
  const apis = items.filter((item): item is CapturedApi => item.kind === "api" && item.path === "/api/echo");
  const errors = ingestErrors(items);
  expect(errors).toHaveLength(2);
  const fetchApi = apis.find(api => api.method === "GET")!;
  const [, trace, span] = fetchApi.headers.traceparent!.split("-");
  expect(errors.find(e => (e.error as { name?: string })?.name === "HTTPError"))
    .toMatchObject({ trace_id: trace, span_id: span });
  expect(apis.find(api => api.method === "POST")!.headers.traceparent).toBe("invalid");
});


test("a rejected reopen preserves the original XHR error report", async ({ page, request }) => {
  const outcome = await page.evaluate(() => new Promise<{ rejected: boolean; status: number }>(resolve => {
    const xhr = new XMLHttpRequest();
    let rejected = false;
    xhr.open("GET", "/api/echo?delay=100&status=500");
    xhr.onload = () => resolve({ rejected, status: xhr.status });
    xhr.send();
    try { xhr.open("INVALID METHOD", "/api/echo?status=200"); }
    catch { rejected = true; }
  }));
  expect(outcome).toEqual({ rejected: true, status: 500 });
  const joined = await pollFor(request, items => {
    const api = items.find((item): item is CapturedApi => item.kind === "api" && item.path === "/api/echo");
    const errors = ingestErrors(items);
    return api?.headers.traceparent && errors.length ? { api, errors } : null;
  });
  const [, trace, span] = joined.api.headers.traceparent!.split("-");
  expect(joined.errors).toHaveLength(1);
  expect(joined.errors[0]).toMatchObject({ trace_id: trace, span_id: span, error: { name: "HTTPError" } });
});

test("abort cleanup in an early timeout handler preserves the timeout report", async ({ page, request }) => {
  await page.evaluate(() => new Promise<void>(resolve => {
    const xhr = new XMLHttpRequest();
    xhr.ontimeout = () => { xhr.abort(); resolve(); };
    xhr.open("GET", "/api/echo?delay=2000");
    xhr.timeout = 100;
    xhr.send();
  }));
  const errors = await pollFor(request, items => {
    const errors = ingestErrors(items);
    return errors.length ? errors : null;
  });
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ error: { name: "TimeoutError" } });
});

for (const source of ["init", "request"] as const) {
  test(`no-cors timeout with mode from ${source} does not invent a trace`, async ({ page, request }) => {
    await page.evaluate(async source => {
      const url = "/api/echo?delay=2000";
      const input = source === "request" ? new Request(url, { mode: "no-cors" }) : url;
      try {
        await fetch(input, { signal: AbortSignal.timeout(100), ...(source === "init" ? { mode: "no-cors" as const } : {}) });
      } catch { /* handled timeout */ }
      (window as any).AppsignalBrowser.captureError(new Error("no-cors-check-finished"));
    }, source);
    const items = await pollFor(request, items => ingestErrors(items).some(e =>
      (e.error as { message?: string })?.message === "no-cors-check-finished") ? items : null);
    const api = items.find((item): item is CapturedApi => item.kind === "api" && item.path === "/api/echo");
    expect(api).toBeDefined();
    expect(api!.headers.traceparent).toBeUndefined();
    expect(ingestErrors(items)).toHaveLength(1);
  });
}


for (const failure of ["http", "timeout"] as const) {
  test(`abort cleanup in an early DONE handler preserves ${failure}`, async ({ page, request }) => {
    await page.evaluate(failure => new Promise<void>(resolve => {
      const xhr = new XMLHttpRequest();
      xhr.onreadystatechange = () => {
        if (xhr.readyState === 4) { xhr.abort(); resolve(); }
      };
      xhr.open("GET", failure === "http" ? "/api/echo?status=500" : "/api/echo?delay=2000");
      xhr.timeout = failure === "timeout" ? 100 : 0;
      xhr.send();
    }), failure);
    const errors = await pollFor(request, items => ingestErrors(items).length ? ingestErrors(items) : null);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ error: { name: failure === "http" ? "HTTPError" : "TimeoutError" } });
  });
}

test("retrying a rejected send preserves one propagated traceparent", async ({ page, request }) => {
  await page.evaluate(() => new Promise<void>(resolve => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/echo?status=500");
    xhr.onload = () => resolve();
    try { xhr.send(Symbol("invalid") as any); } catch { /* correct the body and retry */ }
    xhr.send();
  }));
  const joined = await pollFor(request, items => {
    const api = items.find((item): item is CapturedApi => item.kind === "api" && item.path === "/api/echo");
    const errors = ingestErrors(items);
    return api?.headers.traceparent && errors.length ? { api, errors } : null;
  });
  expect(joined.api.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  const [, trace, span] = joined.api.headers.traceparent!.split("-");
  expect(joined.errors).toHaveLength(1);
  expect(joined.errors[0]).toMatchObject({ trace_id: trace, span_id: span });
});

for (const transport of ["fetch", "xhr"]) test(`${transport} relative URLs honor the actual resolved request blocklist`, async ({ page, request }) => {
  await page.evaluate(async (transport) => {
    const sdk = (window as any).AppsignalBrowser;
    sdk.destroy();
    history.replaceState(null, "", "/api/page");
    sdk.init({ key: "test", endpoint: location.origin, tracePropagationTargets: [location.host + "/**"], privacy: { networkBlocklist: [location.host + "/api/**"] } });
    const status = transport === "fetch"
      ? (await fetch("echo?status=500")).status
      : await new Promise<number>(resolve => {
          const xhr = new XMLHttpRequest();
          xhr.open("GET", "echo?status=500");
          xhr.onload = () => resolve(xhr.status);
          xhr.send();
        });
    if (status !== 500) throw new Error("unexpected response");
    sdk.captureError(new Error("relative-check-finished"));
  }, transport);
  const errors = await pollFor(request, items => {
    const errors = ingestErrors(items);
    return errors.some(e => (e.error as any)?.message === "relative-check-finished") ? errors : null;
  });
  expect(errors.filter(e => (e.error as any)?.name === "HTTPError")).toHaveLength(0);
});
