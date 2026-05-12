// Privacy / PII tests. Each one exercises a real-browser path that the unit
// tests can only mock (scrubUrl, isBlocklisted, rrweb masking, beforeError), so
// a regression that survives the unit suite still lands here.
//
// Pattern: when a test needs non-default config, POST to /__config before
// page.goto so the SDK's first config fetch picks up the override.

import { test, expect } from "../fixtures.js";
import {
  reset,
  captured,
  flush,
  setConfig,
  ingestReplays,
  ingestErrors,
  networkBreadcrumbs,
  pollFor,
  type CapturedApi,
} from "../helpers.js";
import { defaultConfig } from "../default-config.js";

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test.describe("URL scrubbing", () => {
  test("query params are stripped from network breadcrumb URLs by default", async ({ page, request }) => {
    // Default config has query_params_allowlist: [], which strips ALL params.
    // A bug in scrubUrl (or a future config-merge regression) would surface
    // here as the password/token leaking into the URL field.
    await page.goto("/");
    await page.click("#trigger-fetch-sensitive-params");
    await flush(page);

    const breadcrumb = await pollFor(request, (items) =>
      networkBreadcrumbs(items).find((b) =>
        ((b.data as Record<string, unknown>)?.url as string | undefined)?.includes("/api/echo"),
      ),
    );
    const url = (breadcrumb.data as Record<string, unknown>).url as string;
    const message = breadcrumb.message as string;

    expect(url).not.toContain("password");
    expect(url).not.toContain("hunter2");
    expect(url).not.toContain("token");
    expect(url).not.toContain("abc123def456");
    expect(url).not.toContain("?");
    expect(message).not.toContain("password");
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("token");
  });

  test("query_params_allowlist keeps allowed keys and drops everything else", async ({ page, request }) => {
    const config = defaultConfig();
    (config.privacy as Record<string, unknown>).query_params_allowlist = ["page"];
    await setConfig(request, config);

    await page.goto("/");
    await page.click("#trigger-fetch-mixed-params");
    await flush(page);

    const breadcrumb = await pollFor(request, (items) =>
      networkBreadcrumbs(items).find((b) =>
        ((b.data as Record<string, unknown>)?.url as string | undefined)?.includes("/api/echo"),
      ),
    );
    const url = (breadcrumb.data as Record<string, unknown>).url as string;

    expect(url).toContain("page=2");
    expect(url).not.toContain("token");
    expect(url).not.toContain("abc123def456");
  });
});

test.describe("network breadcrumb filtering", () => {
  test("network_blocklist suppresses the network breadcrumb entirely", async ({ page, request }) => {
    // Blocklist match (host + pathname) should mean no network breadcrumb is
    // ever recorded for that URL. The fetch itself still happens (the SDK
    // doesn't block requests, only their breadcrumb), so the API endpoint
    // captures the call — that confirms we tested the right thing rather than
    // a no-op.
    const config = defaultConfig();
    (config.breadcrumbs as Record<string, unknown>).network_blocklist = ["**/auth/**"];
    await setConfig(request, config);

    await page.goto("/");
    await page.click("#trigger-fetch-blocked");
    await flush(page);

    // Confirm the fetch reached the API (so we're testing breadcrumb suppression
    // and not an unrelated failure to fire the request).
    await pollFor(request, (items) =>
      items.find(
        (i): i is CapturedApi => i.kind === "api" && i.path === "/api/auth/login",
      ),
    );

    // Give the breadcrumb pipeline ~2× the normal flush window. If the
    // blocklist breaks, the breadcrumb would have landed within this margin.
    await page.waitForTimeout(1_000);
    await flush(page);

    const blockedCrumbs = networkBreadcrumbs(await captured(request)).filter((b) => {
      const url = (b.data as Record<string, unknown>).url as string;
      return url.includes("/api/auth/login");
    });
    expect(blockedCrumbs).toHaveLength(0);
  });
});

test.describe("session replay masking", () => {
  test("replay does not record raw input values when mask_all_inputs is true", async ({ page, request }) => {
    // rrweb with maskAllInputs:true replaces input values with same-length
    // strings of '*'. The literal typed string must not appear anywhere in the
    // serialised replay events. Default config already sets mask_all_inputs.
    await page.goto("/");

    const secret = "ULTRA_SECRET_PASSWORD_42";
    await page.fill("#masked-input", secret);
    // Blur so rrweb captures the input mutation as a settled event.
    await page.click("body");

    // Wait for at least one replay chunk to land, then capture the full set
    // and assert across all of them.
    const chunks = await pollFor(
      request,
      (items) => {
        const replays = ingestReplays(items);
        return replays.length > 0 ? replays : null;
      },
      { timeout: 8_000 },
    );

    expect(JSON.stringify(chunks)).not.toContain(secret);
    // Sanity: the chunk did capture something — otherwise the negative
    // assertion above passes trivially.
    expect(chunks.some((c) => Array.isArray(c.events) && (c.events as unknown[]).length > 0)).toBe(true);
  });
});

test.describe("error filtering", () => {
  test("beforeError drops matching errors at the entry point", async ({ page, request }) => {
    // beforeError sits early in the pipeline (before the error breadcrumb,
    // before lastErrorTimestamp, before dedupe). A null return drops the
    // error completely. /error-filtering.html drops on the ResizeObserver
    // pattern; a non-matching error must still ship.
    await page.goto("/error-filtering.html");

    await page.evaluate(() => {
      (window as unknown as { throwWithMessage(msg: string): void })
        .throwWithMessage("ResizeObserver loop limit exceeded");
    });
    await page.evaluate(() => {
      (window as unknown as { throwWithMessage(msg: string): void })
        .throwWithMessage("real application error");
    });

    // Wait for the non-matching error to land. If the matching one were also
    // shipped, it would arrive in the same window.
    await pollFor(request, (items) =>
      ingestErrors(items).find(
        (e) => (e.message as string)?.includes("real application error"),
      ),
    );

    const messages = ingestErrors(await captured(request)).map((e) => e.message as string);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("real application error");
    expect(messages[0]).not.toContain("ResizeObserver");
  });
});

test.describe("user context", () => {
  test("clearUser removes user fields from subsequent payloads", async ({ page, request }) => {
    // setUser attaches user_id/user_email/user_name to every payload's session
    // context until cleared. clearUser must remove the in-memory user AND the
    // localStorage copy; the next event's session context must omit those keys.
    await page.goto("/");

    await page.evaluate(() => {
      (window as unknown as {
        AppsignalBrowser: { setUser(u: { id?: string; email?: string }): void };
      }).AppsignalBrowser.setUser({ id: "test-user-1", email: "test@example.com" });
      (window as unknown as { throwWithMessage(msg: string): void })
        .throwWithMessage("first error with user");
    });

    const firstError = await pollFor(request, (items) =>
      ingestErrors(items).find((e) => (e.message as string)?.includes("first error with user")),
    );
    const firstSession = firstError.session as Record<string, unknown>;
    expect(firstSession.user_id).toBe("test-user-1");
    expect(firstSession.user_email).toBe("test@example.com");

    await reset(request);

    await page.evaluate(() => {
      (window as unknown as { AppsignalBrowser: { clearUser(): void } })
        .AppsignalBrowser.clearUser();
      (window as unknown as { throwWithMessage(msg: string): void })
        .throwWithMessage("second error without user");
    });

    const secondError = await pollFor(request, (items) =>
      ingestErrors(items).find((e) => (e.message as string)?.includes("second error without user")),
    );
    const secondSession = secondError.session as Record<string, unknown>;
    expect(secondSession.user_id).toBeUndefined();
    expect(secondSession.user_email).toBeUndefined();
    expect(secondSession.user_name).toBeUndefined();
  });
});

test.describe("beforeError + beforeBreadcrumb", () => {
  test("beforeError drops matching errors; non-matches pass through", async ({ page, request }) => {
    // Real-world use: a known-noisy browser error (e.g. "ResizeObserver loop
    // limit exceeded") is suppressed without dropping anything else. The
    // hook returns null for the matching message and returns the event
    // unchanged otherwise — proves both branches: drop AND pass-through.
    //
    // /pii-redaction.html's beforeError drops on "ResizeObserver" substring.
    await page.goto("/pii-redaction.html");

    await page.evaluate(() => {
      (window as unknown as { throwWithMessage(msg: string): void })
        .throwWithMessage("ResizeObserver loop limit exceeded");
    });
    await page.evaluate(() => {
      (window as unknown as { throwWithMessage(msg: string): void })
        .throwWithMessage("real application error");
    });

    // Wait for the non-matching error to land. If the matching one were also
    // shipped, it would arrive in the same window.
    await pollFor(request, (items) =>
      ingestErrors(items).find(
        (e) => (e.message as string)?.includes("real application error"),
      ),
    );

    const errors = ingestErrors(await captured(request));
    const messages = errors.map((e) => e.message as string);

    // Exactly one error shipped, and it's the non-matching one.
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("real application error");
    expect(messages[0]).not.toContain("ResizeObserver");
  });

  test("beforeError redacts error-only fields; beforeBreadcrumb redacts breadcrumbs", async ({ page, request }) => {
    // Real-world use: strip emails from error payloads so they don't leak
    // server-side. PII can ride through the SDK in three places per error:
    //   - event.message — error-only, redacted in beforeError
    //   - event.stack   — V8 puts the message inside "Error: <message>\n  at …";
    //                     also error-only, redacted in beforeError
    //   - event.breadcrumbs[].message — the SDK auto-adds an error breadcrumb
    //                     with the raw message; cleaned by beforeBreadcrumb at
    //                     insertion. The same hook also keeps the email out
    //                     of breadcrumbs heading to the 30 s events flush.
    // /pii-redaction.html wires both hooks; this test asserts the email
    // appears nowhere in the captured payload.
    await page.goto("/pii-redaction.html");

    const leakyMessage = "failed to load profile for user alice@example.com";
    await page.evaluate((msg) => {
      (window as unknown as { throwWithMessage(msg: string): void })
        .throwWithMessage(msg);
    }, leakyMessage);

    const error = await pollFor(request, (items) =>
      ingestErrors(items).find(
        (e) => (e.message as string)?.includes("failed to load profile"),
      ),
    );
    const message = error.message as string;

    expect(message).toContain("[redacted-email]");
    expect(message).not.toContain("alice@example.com");
    // Whole-payload assertion: the email must not survive in stack or
    // breadcrumbs either. Catches the regression where one of the two hooks
    // forgets to clean its respective channel.
    expect(JSON.stringify(error)).not.toContain("alice@example.com");
  });
});
