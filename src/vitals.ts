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

  onLCP(reporter<LCPMetricWithAttribution>((m) => ({
    element: m.attribution.element || undefined,
  })));

  onCLS(reporter<CLSMetricWithAttribution>((m) => ({
    element: m.attribution.largestShiftTarget || undefined,
  })));

  onINP(reporter<INPMetricWithAttribution>((m) => ({
    element: m.attribution.interactionTarget || undefined,
    interaction_type: m.attribution.interactionType,
  })));

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
    collectedVitals.push({
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

export function destroyVitals(): void {
  destroyed = true;
  collectedVitals = [];
}

export function drainVitals(): VitalEntry[] {
  const vitals = collectedVitals;
  collectedVitals = [];
  return vitals;
}
