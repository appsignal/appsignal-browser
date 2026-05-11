// Basic replay shipping. Verifies the rrweb integration produces a chunk
// containing a FullSnapshot (rrweb event type 2) and that it lands at the
// ingest endpoint as a type:"replay" payload with session_id, tab_id, and
// chunk_index attached. The masking case is covered separately in
// privacy.spec.ts.

import { test, expect } from "../fixtures.js";
import { reset, ingestReplays, pollFor } from "../helpers.js";

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test("replay ships a chunk containing a FullSnapshot", async ({ page, request }) => {
  await page.goto("/");

  // Give rrweb time to load (dynamic import in replay.ts:163) and emit the
  // initial FullSnapshot, then force an early flush via visibilitychange
  // rather than waiting for the 5 s periodic flush.
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  const chunk = await pollFor(
    request,
    (items) =>
      ingestReplays(items).find((r) => {
        const events = r.events as Array<{ type: number }> | undefined;
        // rrweb event type 2 = FullSnapshot — every renderable session
        // must start from one of these.
        return events?.some((e) => e.type === 2);
      }),
    { timeout: 8_000 },
  );

  expect(chunk).toMatchObject({
    type: "replay",
    session_id: expect.any(String),
    tab_id: expect.any(String),
    chunk_index: expect.any(Number),
  });
});
