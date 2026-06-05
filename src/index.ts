import type { BrowserConfig, EventPayload, EventVital, ResolvedConfig } from "./types.js";
import { resolveConfig } from "./types.js";
import { initSession, getSessionContext, setUser as sessionSetUser, clearUser as sessionClearUser, touchActivity, endSession as sessionEndSession, destroySession } from "./session.js";
import { initBreadcrumbs, addManualBreadcrumb, drainBreadcrumbs, destroyBreadcrumbs, onAfterNavigation } from "./breadcrumbs.js";
import { initErrors, reportError, destroyErrors } from "./errors.js";
import { initVitals, drainVitals, destroyVitals, markVitalsNavigation, setRouteTemplate as setVitalsRouteTemplate } from "./vitals.js";

import { initTransport, sendEvents, sendBeaconEvents, destroyTransport } from "./transport.js";
import { initTracing, destroyTracing } from "./tracing.js";
import { initNetworkHook, destroyNetworkHook } from "./network-hook.js";
import { onVisibilityChange, onPageHide, destroyLifecycle } from "./lifecycle.js";

export type { BrowserConfig } from "./types.js";

let clientConfig: BrowserConfig | null = null;
let resolved: ResolvedConfig | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let initialized = false;

// Lifecycle subscription teardowns
let lifecycleUnsubscribers: (() => void)[] = [];

// Internal SDK paths the network-breadcrumb collector must ignore so the
// SDK's own POSTs don't end up in their own breadcrumb trail. Transport
// owns the URL templates per kind; this list only exists for self-filtering.
const EVENTS_PATH = "/ingest/browser";
const ERROR_PATH = "/ingest/browser/errors";
const FLUSH_INTERVAL_MS = 30_000;

export function init(config: BrowserConfig): void {
  if (initialized) return;
  initialized = true;
  clientConfig = config;
  resolved = resolveConfig(config);

  const endpoint = resolveEndpoint(config);
  initTransport(endpoint, config.key);
  startCollection(endpoint);
}

export function setUser(user: { id?: string; email?: string; name?: string }): void {
  if (!initialized) return;
  sessionSetUser(user);
}

export function clearUser(): void {
  if (!initialized) return;
  sessionClearUser();
}

/** End the current browser session. Flushes pending events and replay chunks
 * under the current session_id, then clears session and user state so the next
 * captured event starts a fresh session. Typical use: call on user logout —
 * the flush uses sendBeacon since logout is often followed immediately by a
 * navigation that would cancel a plain fetch. */
export function endSession(): void {
  if (!initialized) return;
  // touchActivity below may rotate the session if the inactivity window has
  // already elapsed (app woke from long sleep). In that case the buffered
  // events we're about to flush get attributed to the fresh session, not
  // the one the caller meant to end; accept this as the documented behavior.
  // The subsequent touchActivity keeps getSessionId() inside flushEvents
  // from rotating again mid-flush.
  touchActivity();
  flushEvents({ beacon: true });
  sessionEndSession();
}

/** Report a caught error manually. Used by framework plugins and try/catch blocks. */
export function captureError(
  error: Error,
  context?: { componentName?: string; [key: string]: unknown },
): void {
  if (!initialized) return;
  reportError(error, context);
}

export function addBreadcrumb(breadcrumb: {
  category: string;
  message: string;
  data?: Record<string, unknown>;
}): void {
  if (!initialized) return;
  addManualBreadcrumb(breadcrumb);
}

/** Tell the SDK which route template the user is currently on — typically
 * a router-shaped string like `/users/:id` or `/orders/[id]/items`.
 *
 * Subsequent web-vital measurements are stamped with this template so the
 * server can aggregate by route instead of by raw URL. Persists until the
 * next call. Pass `null` to clear.
 *
 * If the host app never calls this, the server still groups vitals by an
 * auto-derived template (numeric IDs and UUIDs collapse via regex), but
 * explicit templates produce cleaner buckets — call this on every
 * navigation in your router for best results.
 *
 * @example
 * // React Router
 * useEffect(() => {
 *   appsignal.setRouteTemplate(route.path); // e.g. "/users/:id"
 * }, [route.path]);
 *
 * @example
 * // Next.js App Router
 * useEffect(() => {
 *   appsignal.setRouteTemplate(usePathname()); // e.g. "/users/[id]"
 * }, [pathname]);
 */
export function setRouteTemplate(template: string | null): void {
  if (!initialized) return;
  setVitalsRouteTemplate(template);
}

export function flush(): void {
  flushEvents();
}

/** Tear down the SDK. Flushes remaining data and stops all collection. */
export function destroy(): void {
  if (!initialized) return;
  flushEvents({ beacon: true });
  stopCollection();
  destroySession();
  destroyTransport();
  initialized = false;
  clientConfig = null;
  resolved = null;
}

// --- Internal ---

function resolveEndpoint(config: BrowserConfig): string {
  if (config.endpoint) return config.endpoint.replace(/\/$/, "");
  return location.origin;
}

function startCollection(endpoint: string): void {
  const cfg = resolved!;

  initSession(cfg.session.inactivityTimeoutMs, cfg.privacy.queryParamsAllowlist);
  // Patch fetch/XHR once. Breadcrumbs and tracing both subscribe to the
  // hook instead of patching independently — that's what made destroy order
  // load-bearing.
  initNetworkHook();
  initBreadcrumbs(
    cfg.breadcrumbs,
    [endpoint + EVENTS_PATH, endpoint + ERROR_PATH],
    cfg.privacy.queryParamsAllowlist,
    cfg.privacy.networkBlocklist,
    cfg.privacy.dom,
    clientConfig?.beforeBreadcrumb,
  );
  initErrors(
    cfg.errors,
    clientConfig?.appVersion,
    clientConfig?.beforeError,
  );

  if (clientConfig?.tracePropagationTargets?.length) {
    initTracing(clientConfig.tracePropagationTargets);
  }

  initVitals(cfg.privacy.queryParamsAllowlist);

  // Periodic flush: breadcrumb/session journey only (a no-op when session
  // streaming is off, the default). Vitals are excluded — see flushEvents.
  flushTimer = setInterval(() => flushEvents({ includeVitals: false }), FLUSH_INTERVAL_MS);

  // Flush on visibility hidden (tab switch, app backgrounded). web-vitals
  // listeners are registered first (in initVitals) so they fire before this
  // handler and populate collectedVitals before we flush.
  lifecycleUnsubscribers.push(
    onVisibilityChange((state) => {
      if (state === "hidden") flushEvents({ beacon: true });
    }),
  );
  // Flush on tab close / navigation away
  lifecycleUnsubscribers.push(
    onPageHide((persisted) => {
      if (!persisted && initialized) flushEvents({ beacon: true });
    }),
  );

  // Flush on SPA navigation — use breadcrumbs' central navigation hook
  // instead of wrapping history methods again. Fire *after* the hook so
  // the navigation breadcrumb (added by recordNav via onAfterNavigation)
  // lands in this flush, not the next one.
  //
  // markVitalsNavigation runs *after* flushEvents so any CLS entries
  // accumulated under the outgoing URL ship with their current values
  // before the baseline shifts. Subsequent CLS callbacks then report
  // deltas against the post-flush cumulative — i.e. per-route shifts.
  onAfterNavigation(() => {
    flushEvents();
    markVitalsNavigation();
  });
}

function stopCollection(): void {
  // Unregister listeners before tearing down the hook so the hook doesn't
  // call into half-destroyed modules during in-flight requests.
  destroyTracing();
  destroyBreadcrumbs();
  destroyErrors();
  destroyVitals();
  destroyNetworkHook();

  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  for (const unsub of lifecycleUnsubscribers) unsub();
  lifecycleUnsubscribers = [];
  destroyLifecycle();
}

function flushEvents({
  beacon = false,
  includeVitals = true,
}: { beacon?: boolean; includeVitals?: boolean } = {}): void {
  if (!initialized) return;

  // One POST per flush to /ingest/browser as an `events` payload. The session/
  // journey stream (breadcrumbs, later replay) is included only when
  // `session.enabled` (default false). With it off, only errors + web vitals
  // leave the browser — breadcrumbs are still collected (for error-report
  // context via /ingest/browser/errors and the nav hook that drives per-route
  // vitals), just not shipped here.
  //
  // Vitals drain only when `includeVitals` (SPA navigation, visibility-hidden/
  // pagehide, manual flush/destroy) — never on the periodic timer. Under
  // reportAllChanges the buffered value keeps rising, so a timed drain would
  // ship the same metric repeatedly as separate, non-final samples.
  const sendSessionStream = resolved!.session.enabled;
  const breadcrumbs = sendSessionStream ? drainBreadcrumbs() : [];
  const session = getSessionContext();
  const vitals: EventVital[] = includeVitals
    ? drainVitals().map((v) => ({
        name: v.name,
        value: v.value,
        page_url: v.page_url ?? session.page_url,
        timestamp: v.timestamp,
      }))
    : [];

  if (breadcrumbs.length === 0 && vitals.length === 0) return;

  const payload: EventPayload = {
    type: "events",
    session,
    breadcrumbs,
    vitals,
    app_version: clientConfig?.appVersion,
  };
  if (beacon) {
    sendBeaconEvents(payload);
  } else {
    sendEvents(payload);
  }
}
