import type { VitalEntry } from "./types.js";
import { scrubUrl } from "./utils.js";
import { onCLS, onFCP, onINP, onLCP, onTTFB } from "web-vitals";
import type { Metric } from "web-vitals";

let collectedVitals: VitalEntry[] = [];
let allowlist: string[] = [];

// Route template the host app most recently declared via setRouteTemplate.
// When set, we send it as `page_url` on each vital report — that's the
// aggregation key on the server side, and an explicit template avoids
// any auto-template false positives. When unset (empty string), we fall
// back to `scrubUrl(location.href)` and let the server auto-template it.
// Cleared in destroyVitals so the next init() starts fresh.
let currentRouteTemplate = "";

// Resolve the page_url to send on a vital report: explicit template
// when the host app provided one, otherwise the scrubbed raw URL.
function resolvePageUrl(): string {
  if (currentRouteTemplate) return currentRouteTemplate;
  return scrubUrl(location.href, allowlist);
}

// Route that the load metrics (LCP/FCP/TTFB) are attributed to. These are
// *load* metrics anchored to the initial (hard) navigation: per the Core Web
// Vitals spec, LCP is measured relative to the first navigation and its
// largest-contentful-paint stream is finalized by the first interaction — which
// is exactly the interaction that starts a soft navigation. So a late LCP
// update that fires *after* a client-side route change still belongs to the
// initial route, never the new one (attributing it to the new route is
// spec-incorrect). We freeze the route at the first load-metric report and
// reuse it, so later updates — and reports after a buffer drain — keep the
// initial attribution. (True per-route LCP needs the experimental Soft
// Navigations API; stable web-vitals can't measure it.) Cleared on init.
let loadRoute: string | null = null;

function resolveLoadPageUrl(): string {
  if (loadRoute === null) loadRoute = resolvePageUrl();
  return loadRoute;
}

// Per-SPA-route CLS attribution. Unlike the load metrics, CLS and INP accrue
// over the page lifetime, so they're attributed to the *current* route.
// web-vitals' CLS is cumulative across the whole page-view and never resets on
// history.pushState, so CLS@B reported after a soft nav would include shifts
// from A. We snapshot the cumulative value at every navigation
// (markVitalsNavigation) and report the delta from that snapshot, so each entry
// reflects only the shifts on its own route. INP likewise uses the current
// route; it fires only when the global worst interaction increases, so soft-nav
// routes that don't beat the running record produce no entry — a coverage gap,
// not a correctness one.
let clsBaseline = 0;
let lastReportedCls = 0;

export function initVitals(queryParamsAllowlist: string[]): void {
  collectedVitals = [];
  destroyed = false;
  allowlist = queryParamsAllowlist;
  clsBaseline = 0;
  lastReportedCls = 0;
  currentRouteTemplate = "";
  loadRoute = null;

  // `reportAllChanges: true` surfaces LCP/CLS/INP as they update through the
  // page's life, not just at finalisation. That's what lets the SDK capture a
  // route's CLS/INP at the navigation that ends it — without it, web-vitals
  // reports those once, at page-hide, when an SPA is already on its final
  // route. pushOrReplaceVital keeps only the latest per (metric, page); the
  // flush model (see index.ts) drains vitals only at route/page boundaries, so
  // the rising intermediate values aren't shipped. FCP/TTFB fire once, early,
  // and are registered without it.
  onLCP(reporter(resolveLoadPageUrl), { reportAllChanges: true });

  // CLS uses its own handler instead of `reporter` because the value
  // shipped to the server is the delta from the current page's baseline
  // — not web-vitals' cumulative number. Otherwise a 0.02 shift on B
  // would carry A's accrued shift along with it.
  onCLS(
    (metric: Metric) => {
      if (destroyed) return;
      lastReportedCls = metric.value;
      const pageValue = Math.max(0, metric.value - clsBaseline);
      pushOrReplaceVital({
        name: metric.name,
        timestamp: occurredAt(metric),
        value: pageValue,
        page_url: resolvePageUrl(),
      });
    },
    { reportAllChanges: true },
  );

  // INP accrues per-route → current route (the default resolver).
  onINP(reporter(), { reportAllChanges: true });

  // FCP/TTFB fire once each. Both are load metrics → frozen to the initial route.
  onFCP(reporter(resolveLoadPageUrl));
  onTTFB(reporter(resolveLoadPageUrl));
}

/** Build a web-vitals callback that queues the metric for the next flush.
 * `resolveUrl` decides the route the entry is attributed to (current route
 * by default; the frozen load route for LCP/FCP/TTFB). */
function reporter(resolveUrl: () => string = resolvePageUrl): (metric: Metric) => void {
  return (metric: Metric) => {
    if (destroyed) return;
    pushOrReplaceVital({
      name: metric.name,
      timestamp: occurredAt(metric),
      value: metric.value,
      page_url: resolveUrl(),
    });
  };
}

/** Wall-clock epoch-ms of when the metric actually occurred. A web vital is
 * reported when it finalises — for LCP/CLS/INP that can be long after the
 * event itself (e.g. at page-hide on a long-lived SPA), so `Date.now()` at
 * callback time would stamp it into the wrong minute bucket server-side. Each
 * underlying `PerformanceEntry.startTime` is measured from navigation start;
 * `performance.timeOrigin` anchors that to the epoch. Falls back to now if a
 * metric ever arrives without entries. */
function occurredAt(metric: Metric): number {
  const entries = metric.entries ?? [];
  const last = entries[entries.length - 1];
  return Math.round(performance.timeOrigin + (last ? last.startTime : performance.now()));
}

let destroyed = false;

/** Push a vital entry, replacing any existing entry with the same name and
 * page_url. Used with `reportAllChanges: true` callbacks so intermediate
 * metric updates don't produce duplicate rows — only the latest value for
 * each (metric, page) pair is queued for the next flush. */
function pushOrReplaceVital(entry: VitalEntry): void {
  const idx = collectedVitals.findIndex(
    (v) => v.name === entry.name && v.page_url === entry.page_url,
  );
  if (idx >= 0) collectedVitals[idx] = entry;
  else collectedVitals.push(entry);
}

export function destroyVitals(): void {
  destroyed = true;
  collectedVitals = [];
  clsBaseline = 0;
  lastReportedCls = 0;
  currentRouteTemplate = "";
  loadRoute = null;
}

/** Set the route template the host app considers current — e.g.
 * `/users/:id` for a route that renders any user profile. While set,
 * every subsequent vital report ships this string as its `page_url`
 * instead of the browser's actual URL. Persists until the next call.
 * Pass `null` (or an empty string) to clear so the next report falls
 * back to `scrubUrl(location.href)` (the server then auto-templates it).
 *
 * Call this on every navigation in your router (e.g. inside Next.js'
 * `useEffect(() => …, [pathname])` or React Router's location listener).
 * Without it, the server still auto-templates raw URLs (`/users/42` →
 * `/users/:id`) using regex heuristics — but explicit templates avoid
 * false positives on patterns the regex doesn't recognise. */
export function setRouteTemplate(template: string | null): void {
  currentRouteTemplate = template ?? "";
}

/** Called on every SPA navigation (history.pushState / replaceState /
 * popstate). Sets the CLS baseline so subsequent CLS callbacks report
 * the delta — i.e. shifts that occurred on the new route only. Should
 * fire *after* any pending vitals have been flushed for the outgoing
 * URL so the new baseline only affects future reports. */
export function markVitalsNavigation(): void {
  clsBaseline = lastReportedCls;
}

export function drainVitals(): VitalEntry[] {
  const vitals = collectedVitals;
  collectedVitals = [];
  return vitals;
}
