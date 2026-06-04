import type { VitalEntry } from "./types.js";
import { scrubUrl } from "./utils.js";
import { onCLS, onFCP, onINP, onLCP, onTTFB } from "web-vitals/attribution";
import type {
  LCPMetricWithAttribution,
  CLSMetricWithAttribution,
  INPMetricWithAttribution,
  MetricWithAttribution,
} from "web-vitals/attribution";

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

  // LCP, INP, and CLS all finalise through web-vitals' `whenIdleOrHidden`
  // helper, which uses `requestIdleCallback` (or `setTimeout(0)` as a
  // fallback). All three run AFTER our flush on page-unload, so the final
  // metric would land in collectedVitals too late to ship. Using
  // `reportAllChanges: true` pushes values during the page's normal
  // lifetime as they update, and pushOrReplaceVital keeps only the latest
  // per (metric, page) so we don't pollute parquet with intermediate rows.
  // FCP and TTFB fire once early in the page, so they don't need this.
  onLCP(
    reporter<LCPMetricWithAttribution>(
      (m) => ({ element: m.attribution.element || undefined }),
      resolveLoadPageUrl,
    ),
    { reportAllChanges: true },
  );

  // CLS uses its own handler instead of `reporter` because the value
  // shipped to the server is the delta from the current page's baseline
  // — not web-vitals' cumulative number. Rating is also re-computed
  // against Google's CLS thresholds from the per-page value, otherwise
  // a 0.02 shift on B would inherit "poor" if A had already accrued 0.4.
  onCLS(
    (metric: CLSMetricWithAttribution) => {
      if (destroyed) return;
      lastReportedCls = metric.value;
      const pageValue = Math.max(0, metric.value - clsBaseline);
      pushOrReplaceVital({
        id: metric.id,
        label: "browser-web-vital",
        name: metric.name,
        startTime: Date.now(),
        value: pageValue,
        page_url: resolvePageUrl(),
        rating: rateCls(pageValue),
        element: metric.attribution.largestShiftTarget || undefined,
      });
    },
    { reportAllChanges: true },
  );

  // INP accrues per-route → current route (the default resolver).
  onINP(
    reporter<INPMetricWithAttribution>((m) => ({
      element: m.attribution.interactionTarget || undefined,
      interaction_type: m.attribution.interactionType,
    })),
    { reportAllChanges: true },
  );

  // FCP/TTFB fire once each, with no per-target attribution to add. Both are
  // load metrics → frozen to the initial route.
  onFCP(reporter<MetricWithAttribution>(() => ({}), resolveLoadPageUrl));
  onTTFB(reporter<MetricWithAttribution>(() => ({}), resolveLoadPageUrl));
}

/** Build a web-vitals callback. The extractor adds metric-specific fields
 * (element, interaction_type) on top of the common shape required by the
 * server's WebVital struct. */
function reporter<T extends MetricWithAttribution>(
  extract: (m: T) => Partial<VitalEntry>,
  resolveUrl: () => string = resolvePageUrl,
): (metric: T) => void {
  return (metric: T) => {
    if (destroyed) return;
    pushOrReplaceVital({
      id: metric.id,
      label: "browser-web-vital",
      name: metric.name,
      startTime: Date.now(),
      value: metric.value,
      page_url: resolveUrl(),
      rating: metric.rating,
      ...extract(metric),
    });
  };
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

/** Re-rate a per-page CLS value against Google's official thresholds.
 * Used because the rating attached by web-vitals reflects the cumulative
 * (page-view-wide) value, not the per-page delta we emit. */
function rateCls(value: number): "good" | "needs-improvement" | "poor" {
  if (value <= 0.1) return "good";
  if (value <= 0.25) return "needs-improvement";
  return "poor";
}

export function drainVitals(): VitalEntry[] {
  const vitals = collectedVitals;
  collectedVitals = [];
  return vitals;
}
