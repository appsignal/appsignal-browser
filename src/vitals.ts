import type { EventVital } from "./types.js";
import { scrubUrl } from "./utils.js";
import { onFCP, onLCP, onTTFB } from "web-vitals";
import type { Metric } from "web-vitals";

// Per-route web vitals.
//
// LCP/FCP/TTFB are *load* metrics — the browser measures them once, relative to
// the initial (hard) navigation, and never re-fires them for SPA soft
// navigations. We take them from the web-vitals library (it handles the
// bfcache/visibility quirks) and attribute them to the route the page loaded
// on. This matches Datadog/Sentry/CrUX: per-route LCP/FCP for soft navigations
// is not available in stable browsers (it needs the experimental Soft
// Navigations API), so these stay initial-load only.
//
// CLS and INP *do* accrue over the page lifetime and can be attributed per
// route. web-vitals reports them as a single cumulative page-view value, which
// can't be sliced per soft navigation — so for these two we observe the raw
// `layout-shift` / `event-timing` performance entries ourselves and bucket them
// into the active route, resetting at each navigation. (This is the same
// approach Datadog uses; it's best-effort — a late-arriving buffered entry is
// attributed to the route active when the observer delivers it.)

let collectedVitals: EventVital[] = [];
let allowlist: string[] = [];
let destroyed = false;

// Route template the host app most recently declared via setRouteTemplate.
// When set, we send it as `page_url` on each vital report — that's the
// aggregation key on the server side, and an explicit template avoids any
// auto-template false positives. When unset (empty string), we fall back to
// `scrubUrl(location.href)` and let the server auto-template it.
let currentRouteTemplate = "";

// Route the load metrics (LCP/FCP/TTFB) are attributed to, frozen on first use
// so all three share one value (page-load route). Cleared on init.
let loadRoute: string | null = null;

export function initVitals(queryParamsAllowlist: string[]): void {
  collectedVitals = [];
  destroyed = false;
  allowlist = queryParamsAllowlist;
  currentRouteTemplate = "";
  loadRoute = null;
  resetRouteVitals();

  // Load metrics: fire once when final, attributed to the load route. No
  // `reportAllChanges` — that's a debug-only mode the web-vitals docs advise
  // against in production.
  onLCP(reportLoadMetric);
  onFCP(reportLoadMetric);
  onTTFB(reportLoadMetric);

  // CLS / INP: observe the raw entries and bucket per route ourselves.
  observeLayoutShifts();
  observeInteractions();
}

// --- Load metrics (LCP/FCP/TTFB) -------------------------------------------

function reportLoadMetric(metric: Metric): void {
  if (destroyed) return;
  pushOrReplaceVital({
    name: metric.name,
    value: metric.value,
    page_url: resolveLoadRoute(),
    timestamp: occurredAt(metric),
  });
}

/** Wall-clock epoch-ms of when a load metric occurred. web-vitals reports the
 * value when it finalises — possibly long after the event — so we anchor the
 * entry's navigation-relative `startTime` to the epoch via `timeOrigin` rather
 * than stamping the callback time. Falls back to now if a metric ever arrives
 * without entries. */
function occurredAt(metric: Metric): number {
  const entries = metric.entries ?? [];
  const last = entries[entries.length - 1];
  return toEpoch(last ? last.startTime : performance.now());
}

function resolveLoadRoute(): string {
  if (loadRoute === null) loadRoute = resolvePageUrl();
  return loadRoute;
}

// --- CLS (per route, official session-window algorithm) --------------------

interface LayoutShiftEntry extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
}

let clsObserver: PerformanceObserver | null = null;
let clsSessionValue = 0; // sum of shifts in the current session window
let clsSessionMax = 0; // largest session window seen for the current route
let clsFirstShiftTs = 0;
let clsLastShiftTs = 0;

function observeLayoutShifts(): void {
  if (!supportsEntry("layout-shift")) return;
  clsObserver = new PerformanceObserver((list) => {
    if (destroyed) return;
    for (const entry of list.getEntries() as LayoutShiftEntry[]) {
      // Shifts within 500ms of user input don't count toward CLS.
      if (entry.hadRecentInput) continue;
      // A session window ends after a 1s gap between shifts or once it has been
      // open for 5s; whichever comes first starts a new window. CLS is the
      // largest window — here, the largest window within the current route.
      if (
        clsSessionValue !== 0 &&
        (entry.startTime - clsLastShiftTs > 1000 ||
          entry.startTime - clsFirstShiftTs > 5000)
      ) {
        clsSessionValue = entry.value;
        clsFirstShiftTs = entry.startTime;
      } else {
        if (clsSessionValue === 0) clsFirstShiftTs = entry.startTime;
        clsSessionValue += entry.value;
      }
      clsLastShiftTs = entry.startTime;
      if (clsSessionValue > clsSessionMax) clsSessionMax = clsSessionValue;
    }
  });
  clsObserver.observe({ type: "layout-shift", buffered: true });
}

// --- INP (per route, worst-interaction percentile) -------------------------

interface InteractionEntry extends PerformanceEntry {
  interactionId?: number;
  duration: number;
}

let inpObserver: PerformanceObserver | null = null;
let firstInputObserver: PerformanceObserver | null = null;
// interactionId -> max event duration for that interaction, scoped to the
// current route. A keyboard/tap interaction emits several event-timing entries
// sharing one interactionId; the interaction's latency is the longest of them.
let interactions = new Map<number, number>();
let inpLastTs = 0;

function observeInteractions(): void {
  if (!supportsEntry("event")) return;
  inpObserver = new PerformanceObserver((list) => {
    if (destroyed) return;
    for (const entry of list.getEntries() as InteractionEntry[]) {
      // interactionId 0 means the event isn't part of a discrete interaction
      // (e.g. a continuous scroll event) — it doesn't count toward INP.
      const id = entry.interactionId ?? 0;
      if (id === 0) continue;
      recordInteraction(id, entry.duration, entry.startTime);
    }
  });
  inpObserver.observe({ type: "event", buffered: true, durationThreshold: 40 } as PerformanceObserverInit);
  // first-input is reported under its own entry type and may precede the first
  // `event`; it has no interactionId, so bucket it under a sentinel key that
  // can't collide with a real one.
  if (supportsEntry("first-input")) {
    firstInputObserver = new PerformanceObserver((list) => {
      if (destroyed) return;
      for (const entry of list.getEntries() as InteractionEntry[]) {
        recordInteraction(-1, entry.duration, entry.startTime);
      }
    });
    firstInputObserver.observe({ type: "first-input", buffered: true });
  }
}

function recordInteraction(key: number, duration: number, startTime: number): void {
  const prev = interactions.get(key) ?? 0;
  if (duration > prev) interactions.set(key, duration);
  if (startTime > inpLastTs) inpLastTs = startTime;
}

/** INP for the current route: the high-percentile worst interaction. With <50
 * interactions that's the single worst; above that, web-vitals' rule of one
 * excluded per 50 (the floor(count/50)-th worst). */
function computeRouteInp(): number | null {
  if (interactions.size === 0) return null;
  const sorted = [...interactions.values()].sort((a, b) => b - a);
  const idx = Math.min(sorted.length - 1, Math.floor(interactions.size / 50));
  return Math.round(sorted[idx]);
}

// --- Route lifecycle --------------------------------------------------------

/** Materialise the current route's accumulated CLS and INP as vital entries
 * ready for the next flush. Called at every route/page boundary (see index.ts)
 * before draining. Idempotent within a flush buffer — pushOrReplaceVital keys
 * on (name, page_url), so finalising twice updates rather than duplicates. */
export function finalizeRouteVitals(): void {
  if (destroyed) return;
  const page_url = resolvePageUrl();
  if (clsSessionMax > 0) {
    pushOrReplaceVital({
      name: "CLS",
      value: clsSessionMax,
      page_url,
      timestamp: toEpoch(clsLastShiftTs),
    });
  }
  const inp = computeRouteInp();
  if (inp !== null) {
    pushOrReplaceVital({
      name: "INP",
      value: inp,
      page_url,
      timestamp: toEpoch(inpLastTs),
    });
  }
}

/** Start measuring CLS/INP afresh for a new SPA route. Call *after* the
 * outgoing route has been finalised and flushed, so its accumulated shifts and
 * interactions don't leak into the new route. */
export function markVitalsNavigation(): void {
  resetRouteVitals();
}

function resetRouteVitals(): void {
  clsSessionValue = 0;
  clsSessionMax = 0;
  clsFirstShiftTs = 0;
  clsLastShiftTs = 0;
  interactions = new Map();
  inpLastTs = 0;
}

/** Set the route template the host app considers current — e.g. `/users/:id`
 * for a route that renders any user profile. While set, vital reports ship this
 * string as `page_url` instead of the raw URL. Persists until the next call;
 * pass `null` (or "") to clear and fall back to `scrubUrl(location.href)` (the
 * server then auto-templates it).
 *
 * Call this on every navigation in your router so CLS/INP attribute to the
 * route they occurred on, and call it as early as possible on first load so the
 * landing route's LCP/FCP get the template too.
 *
 * @example
 * // React Router
 * useEffect(() => appsignal.setRouteTemplate(route.path), [route.path]);
 * @example
 * // Next.js App Router
 * useEffect(() => appsignal.setRouteTemplate(usePathname()), [pathname]); */
export function setRouteTemplate(template: string | null): void {
  currentRouteTemplate = template ?? "";
}

export function drainVitals(): EventVital[] {
  const vitals = collectedVitals;
  collectedVitals = [];
  return vitals;
}

export function destroyVitals(): void {
  destroyed = true;
  collectedVitals = [];
  currentRouteTemplate = "";
  loadRoute = null;
  resetRouteVitals();
  clsObserver?.disconnect();
  inpObserver?.disconnect();
  firstInputObserver?.disconnect();
  clsObserver = null;
  inpObserver = null;
  firstInputObserver = null;
}

// --- helpers ----------------------------------------------------------------

function resolvePageUrl(): string {
  if (currentRouteTemplate) return currentRouteTemplate;
  return scrubUrl(location.href, allowlist);
}

function toEpoch(entryTime: number): number {
  return Math.round(performance.timeOrigin + entryTime);
}

/** Push a vital entry, replacing any existing entry with the same name and
 * page_url so a route's metric appears once per flush with its latest value. */
function pushOrReplaceVital(entry: EventVital): void {
  const idx = collectedVitals.findIndex(
    (v) => v.name === entry.name && v.page_url === entry.page_url,
  );
  if (idx >= 0) collectedVitals[idx] = entry;
  else collectedVitals.push(entry);
}

function supportsEntry(type: string): boolean {
  return (
    typeof PerformanceObserver !== "undefined" &&
    Array.isArray(PerformanceObserver.supportedEntryTypes) &&
    PerformanceObserver.supportedEntryTypes.includes(type)
  );
}
