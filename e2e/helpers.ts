// Shared test helpers. Types, server-state accessors, ingest payload filters,
// and a pollFor() utility that replaces the verbose
//   expect.poll(predicate).toBeTruthy(); items.find(predicate)!
// pattern with a single call that returns the matched value.

import { expect, type APIRequestContext, type Page } from "./fixtures.js";

export interface CapturedIngest {
  kind: "ingest";
  path: string;
  query: Record<string, string>;
  body: string;
  receivedAt: number;
}
export interface CapturedApi {
  kind: "api";
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | undefined>;
  body: string;
  receivedAt: number;
}
export type Captured = CapturedIngest | CapturedApi;

export async function reset(request: APIRequestContext): Promise<void> {
  await request.post("/__reset");
}

export async function captured(request: APIRequestContext): Promise<Captured[]> {
  const r = await request.get("/__captured");
  return (await r.json()) as Captured[];
}

/** Inject an SDK config override into the page before any script runs. The
 * sample app reads window.__appsignalConfig in its init() call and spreads
 * it over its default options — lets a test exercise allowlists, blocklists,
 * etc. without a dedicated sample page per scenario. */
export async function withSdkConfig(
  page: Page,
  config: Record<string, unknown>,
): Promise<void> {
  await page.addInitScript((cfg) => {
    (window as unknown as { __appsignalConfig: Record<string, unknown> }).__appsignalConfig = cfg;
  }, config);
}

/** Kept for the skipped replay/error-replay specs. v1 does not ship a
 * server-side config endpoint; the /__config route is also gone, so a call
 * here would 404. Tests using it are marked `test.skip` until replay
 * returns and the route comes back. */
export async function setConfig(
  _request: APIRequestContext,
  _config: Record<string, unknown>,
): Promise<void> {
  /* no-op shim */
}

/** Force a flush via the SDK's flush() API after waiting long enough for any
 * in-flight network-breadcrumb async work to settle. recordNetworkBreadcrumb
 * awaits the response body and a 150 ms resource-timing settle before the
 * breadcrumb lands in the buffer; 500 ms covers both with margin. */
export async function flush(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 500));
    (window as unknown as { AppsignalBrowser: { flush(): void } }).AppsignalBrowser.flush();
  });
}

function jsonBodiesOfType(items: Captured[], type: string): Array<Record<string, unknown>> {
  return items
    .filter((i): i is CapturedIngest => i.kind === "ingest")
    .map((i) => {
      try { return JSON.parse(i.body) as Record<string, unknown>; } catch { return null; }
    })
    .filter((b): b is Record<string, unknown> => b !== null && b.type === type);
}

export function ingestEvents(items: Captured[]): Array<Record<string, unknown>> {
  return jsonBodiesOfType(items, "events");
}

/** Kept for the skipped replay/error-replay specs. */
export function ingestReplays(items: Captured[]): Array<Record<string, unknown>> {
  return jsonBodiesOfType(items, "replay");
}

export function ingestErrors(items: Captured[]): Array<Record<string, unknown>> {
  return jsonBodiesOfType(items, "error");
}

export function networkBreadcrumbs(items: Captured[]): Array<Record<string, unknown>> {
  return ingestEvents(items)
    .flatMap((e) => (e.breadcrumbs as Array<Record<string, unknown>>) ?? [])
    .filter((b) => b.category === "network");
}

/** Poll the captured server state until `predicate` returns truthy; return the
 * matched value typed as NonNullable<T>. Replaces the
 *   expect.poll(...).toBeTruthy(); items.find(samePredicate)!
 * pattern — one source of truth for the match condition. */
export async function pollFor<T>(
  request: APIRequestContext,
  predicate: (items: Captured[]) => T | undefined | null,
  options: { timeout?: number } = {},
): Promise<NonNullable<T>> {
  let matched: T | undefined | null;
  await expect.poll(async () => {
    matched = predicate(await captured(request));
    return matched;
  }, { timeout: options.timeout ?? 5_000 }).toBeTruthy();
  return matched as NonNullable<T>;
}
