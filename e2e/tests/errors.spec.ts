// End-to-end error capture. Two paths through errors.ts:initErrors —
// window.onerror (synchronous throws that escape the call stack) and
// unhandledrejection (promise rejects with no .catch). Both must produce
// a type:"error" payload at the ingest endpoint, with the original
// message intact and a session_id attached.

import { test, expect } from "../fixtures.js";
import { reset, ingestErrors, pollFor } from "../helpers.js";

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test("uncaught throw is captured via window.onerror", async ({ page, request }) => {
  await page.goto("/");
  await page.click("#throw-error");

  const err = await pollFor(request, (items) =>
    ingestErrors(items).find(
      (e) => typeof e.message === "string" && e.message.includes("e2e thrown error"),
    ),
  );

  expect(err).toMatchObject({
    type: "error",
    message: expect.stringContaining("e2e thrown error"),
    session: expect.objectContaining({ session_id: expect.any(String) }),
  });
});

test("unhandled promise rejection is captured via unhandledrejection", async ({ page, request }) => {
  await page.goto("/");
  // Use a unique message to dodge the 10 s/5-occurrence dedupe window in
  // errors.ts:checkDedupe in case any other test left an entry behind.
  const marker = `e2e unhandled rejection ${Date.now()}`;
  await page.evaluate((msg) => {
    Promise.reject(new Error(msg));
  }, marker);

  const err = await pollFor(request, (items) =>
    ingestErrors(items).find(
      (e) => typeof e.message === "string" && e.message.includes(marker),
    ),
  );

  expect(err).toMatchObject({
    type: "error",
    message: expect.stringContaining(marker),
    error_class: "Error",
  });
});
