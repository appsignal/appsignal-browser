// End-to-end resilience: the SDK must never become a source of problems for
// the host page. Each test reproduces, through the *built bundle*, a way the
// SDK could break or overwhelm a host site, and asserts it doesn't.
//
// Offline behaviour (queue + drain on reconnect) is covered separately in
// offline.spec.ts.

import { test, expect, type Page } from "../fixtures.js";
import {
  reset,
  captured,
  ingestErrors,
  pollFor,
  type CapturedApi,
} from "../helpers.js";

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test("network hook preserves headers carried on a Request input", async ({
  page,
  request,
}) => {
  // The wrapper used to rebuild every request with `new Headers(init?.headers)`,
  // which is empty for fetch(request) and silently dropped Authorization /
  // custom headers — breaking authenticated requests on the host site.
  await page.goto("/resilience.html");
  await page.evaluate(() => (window as unknown as {
    __fetchWithRequestHeaders(): Promise<Response>;
  }).__fetchWithRequestHeaders());

  const echo = await pollFor(request, (items) =>
    items.find(
      (i): i is CapturedApi => i.kind === "api" && i.path === "/api/echo",
    ),
  );

  expect(echo.headers.authorization).toBe("Bearer SECRET");
  expect(echo.headers["x-custom"]).toBe("1");
});

test("console.error with a circular argument does not throw into host code", async ({
  page,
  request,
}) => {
  await page.goto("/resilience.html");

  // The driver returns whether the patched console.error threw. It must not.
  const threw = await page.evaluate(() => (window as unknown as {
    __consoleCircular(): boolean;
  }).__consoleCircular());
  expect(threw).toBe(false);

  // And the breadcrumb is still captured (degraded, not dropped).
  await flushAfterSettle(page);
  const consoleCrumb = await pollFor(request, (items) =>
    ingestConsole(items).find(
      (b) => typeof b.message === "string" && b.message.includes("circular boom"),
    ),
  );
  expect(consoleCrumb.message).toContain("circular boom");
});

test("error storm is rate-limited so it can't flood ingest", async ({
  page,
  request,
}) => {
  await page.goto("/resilience.html");

  // 130 distinct error messages — distinct so dedupe (per-key) can't catch
  // them. Without the global cap this would produce 130 error POSTs.
  await page.evaluate(() => (window as unknown as {
    __errorStorm(n: number): void;
  }).__errorStorm(130));

  // Wait for the storm to flow, then let it settle and read the final count.
  await pollFor(request, (items) =>
    ingestErrors(items).length >= 1 ? true : undefined,
  );
  await page.waitForTimeout(1500);

  const errorCount = ingestErrors(await captured(request)).length;
  // The cap engages (≈100 reach the wire) and holds (never above the 100
  // limit, far below the 130 fired). Without the global rate limit all 130
  // distinct errors would POST.
  expect(errorCount).toBeGreaterThanOrEqual(95);
  expect(errorCount).toBeLessThanOrEqual(100);
});

// --- helpers ---------------------------------------------------------------

/** Flush after waiting for in-flight async breadcrumb work to settle. */
async function flushAfterSettle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 300));
    (window as unknown as { AppsignalBrowser: { flush(): void } }).AppsignalBrowser.flush();
  });
}

function ingestConsole(
  items: Awaited<ReturnType<typeof captured>>,
): Array<Record<string, unknown>> {
  // Reuse the events flattening: console breadcrumbs ride the events payload.
  return (items as Array<{ kind: string; path?: string; body?: string }>)
    .filter((i) => i.kind === "ingest" && i.path === "/ingest/browser")
    .flatMap((i) => {
      try {
        const b = JSON.parse((i as { body: string }).body) as Record<string, unknown>;
        return (b.breadcrumbs as Array<Record<string, unknown>>) ?? [];
      } catch {
        return [];
      }
    })
    .filter((b) => b.category === "console");
}
