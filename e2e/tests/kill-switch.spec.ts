// Server-config kill switch. When /ingest/browser/config returns
// { enabled: false }, applyServerConfig (index.ts:208-216) must discard the
// replay buffer, clear breadcrumbs, and tear down every collector. After
// that, nothing the page does — clicks, fetches, thrown errors, visibility
// changes — should produce any further POST to /ingest/browser.

import { test, expect } from "../fixtures.js";
import { reset, setConfig, captured } from "../helpers.js";
import { defaultConfig } from "../default-config.js";

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test("enabled: false stops all collection after the config arrives", async ({ page, request }) => {
  const config = defaultConfig();
  config.enabled = false;
  await setConfig(request, config);

  await page.goto("/");

  // The config fetch is async — give it time to land and applyServerConfig
  // to run. On localhost this is normally <100 ms; 1 s is comfortable
  // margin without making the test slow.
  await page.waitForTimeout(1000);

  // Now drive every path that would normally produce an ingest POST.
  await page.click("#add-breadcrumb");
  await page.click("#trigger-fetch");
  await page.click("#throw-error");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
  });

  // Wait past the replay 5 s flush interval — any leftover timer would
  // have fired by now.
  await page.waitForTimeout(5500);

  const ingestPosts = (await captured(request)).filter(
    (i) => i.kind === "ingest" && i.path === "/ingest/browser",
  );
  expect(ingestPosts).toHaveLength(0);
});
