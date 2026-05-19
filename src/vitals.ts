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

export function initVitals(queryParamsAllowlist: string[]): void {
  collectedVitals = [];
  destroyed = false;
  allowlist = queryParamsAllowlist;

  // LCP, INP, and CLS all finalise through web-vitals' `whenIdleOrHidden`
  // helper, which uses `requestIdleCallback` (or `setTimeout(0)` as a
  // fallback). All three run AFTER our flush on page-unload, so the final
  // metric would land in collectedVitals too late to ship. Using
  // `reportAllChanges: true` pushes values during the page's normal
  // lifetime as they update, and pushOrReplaceVital keeps only the latest
  // per (metric, page) so we don't pollute parquet with intermediate rows.
  // FCP and TTFB fire once early in the page, so they don't need this.
  onLCP(
    reporter<LCPMetricWithAttribution>((m) => ({
      element: m.attribution.element || undefined,
    })),
    { reportAllChanges: true },
  );

  onCLS(
    reporter<CLSMetricWithAttribution>((m) => ({
      element: m.attribution.largestShiftTarget || undefined,
    })),
    { reportAllChanges: true },
  );

  onINP(
    reporter<INPMetricWithAttribution>((m) => ({
      element: m.attribution.interactionTarget || undefined,
      interaction_type: m.attribution.interactionType,
    })),
    { reportAllChanges: true },
  );

  // FCP/TTFB fire once each, with no per-target attribution to add.
  onFCP(reporter<MetricWithAttribution>(() => ({})));
  onTTFB(reporter<MetricWithAttribution>(() => ({})));
}

/** Build a web-vitals callback. The extractor adds metric-specific fields
 * (element, interaction_type) on top of the common name/value/rating shape. */
function reporter<T extends MetricWithAttribution>(
  extract: (m: T) => Partial<VitalEntry>,
): (metric: T) => void {
  return (metric: T) => {
    if (destroyed) return;
    pushOrReplaceVital({
      name: `web.vital.${metric.name.toLowerCase()}`,
      value: metric.value,
      rating: metric.rating,
      page_url: scrubUrl(location.href, allowlist),
      timestamp: Date.now(),
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
}

export function drainVitals(): VitalEntry[] {
  const vitals = collectedVitals;
  collectedVitals = [];
  return vitals;
}
