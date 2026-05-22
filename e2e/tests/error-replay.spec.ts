// Error-driven replay shipping. With sample_rate: 0 + error_replay: true,
// rrweb keeps recording but flushChunk drops every buffer (replay.ts:238)
// until an error opens the window. handleError → onErrorReported →
// replay.ts:onError immediately flushes the pre-error buffer and opens a
// 5 s tail (replay.ts:142-156). Without this spec, a regression in the
// errors→replay wire would silently lose the most diagnostically useful
// chunks: the ones explaining what the user just did before the crash.
//
// v1 skip: session replay isn't wired into index.ts (rrweb is not bundled),
// and the /__config + /ingest/browser/config routes the test drives are
// gone. Spec stays as a future-state reference; re-enable when replay and
// its config-delivery path return.

import { test, expect } from "../fixtures.js";
import { reset, setConfig, captured, ingestReplays, pollFor } from "../helpers.js";

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test.skip("error on an unsampled session ships a replay chunk via the error window", async ({ page, request }) => {
  // Narrows replay sampling so only the error-window path can produce a
  // chunk. Exact shape is a placeholder — when replay returns, this gets
  // rewritten against whatever config-delivery API v2 ships with.
  await setConfig(request, { replay: { sample_rate: 0, error_replay: true } });

  await page.goto("/");

  // Give rrweb time to load and emit the initial FullSnapshot. The 5 s
  // flush timer fires during this wait but bails because !sampled and no
  // error has occurred yet.
  await page.waitForTimeout(1500);

  const replaysBeforeError = ingestReplays(await captured(request));
  expect(replaysBeforeError).toHaveLength(0);

  await page.click("#throw-error");

  // The chunk arrives via the error window: errors.ts publishes to
  // onErrorReported subscribers; replay.ts:onError calls flushChunk which
  // sees errorReplayEnabled && hadError and ships the buffered events,
  // including the initial FullSnapshot.
  const chunk = await pollFor(request, (items) =>
    ingestReplays(items).find((r) => {
      const events = r.events as Array<{ type: number }> | undefined;
      return events?.some((e) => e.type === 2);
    }),
  );

  expect(chunk).toMatchObject({
    type: "replay",
    session_id: expect.any(String),
    tab_id: expect.any(String),
  });
});
