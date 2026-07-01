import type { BrowserConfig, EventPayload, ResolvedConfig, UserContext } from "./types.js";
import { resolveConfig } from "./types.js";
import { initSession, getSessionContext, setUser as sessionSetUser, clearUser as sessionClearUser, setTags as sessionSetTags, clearTags as sessionClearTags, touchActivity, endSession as sessionEndSession, destroySession } from "./session.js";
import { initBreadcrumbs, addManualBreadcrumb, drainBreadcrumbs, destroyBreadcrumbs, onAfterNavigation } from "./breadcrumbs.js";
import { initErrors, reportError, destroyErrors } from "./errors.js";
import { initVitals, drainVitals, finalizeRouteVitals, destroyVitals, markVitalsNavigation, setRouteTemplate as setVitalsRouteTemplate } from "./vitals.js";

import { initTransport, sendEvents, sendBeaconEvents, destroyTransport, EVENTS_PATH, ERROR_PATH } from "./transport.js";
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

// EVENTS_PATH / ERROR_PATH are imported from transport (the owner of the wire
// URLs) and reused here for network-breadcrumb self-filtering, so the SDK's own
// POSTs don't end up in their own breadcrumb trail — and a future endpoint
// change can't drift between the two files.
const FLUSH_INTERVAL_MS = 30_000;

export function init(config: BrowserConfig): void {
  if (initialized) return;
  // Master off-switch: `active: false` makes init a complete no-op — nothing
  // patched, no timers, no network. Consumers gate this on their build env
  // (e.g. `active: import.meta.env.PROD`) so dev/test/CI never sends data.
  // Public methods already guard on `initialized`, so they stay safe no-ops.
  if (config.active === false) return;
  initialized = true;
  clientConfig = config;
  resolved = resolveConfig(config);

  const endpoint = resolveEndpoint(config);
  initTransport(endpoint, config.key);
  startCollection(endpoint);
}

/** Identify the current user (`id`, `email`, `name`). Rides the session/journey
 * stream as user context. Does not tag errors — for error-filtering metadata
 * (and to put user info on errors), use {@link setTags}. Call {@link clearUser}
 * on logout to drop identity. */
export function setUser(user: UserContext): void {
  if (!initialized) return;
  sessionSetUser(user);
}

export function clearUser(): void {
  if (!initialized) return;
  sessionClearUser();
}

/** Attach arbitrary string tags to every subsequent error payload, for
 * filtering/searching errors in the UI — e.g.
 * `setTags({ plan: "pro", org_id: "acme" })`. Merges with any existing tags;
 * pass an empty value to drop a key. Values are coerced to strings and the set
 * is capped. Use {@link clearTags} to reset. */
export function setTags(tags: Record<string, unknown>): void {
  if (!initialized) return;
  sessionSetTags(tags);
}

export function clearTags(): void {
  if (!initialized) return;
  sessionClearTags();
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
    cfg.privacy.queryParamsAllowlist,
    clientConfig?.appVersion,
    clientConfig?.beforeError,
  );

  if (clientConfig?.tracePropagationTargets?.length) {
    initTracing(clientConfig.tracePropagationTargets);
  }

  initVitals(cfg.privacy.queryParamsAllowlist);

  // Periodic flush: breadcrumb/session journey only — vitals are excluded (see
  // flushEvents) and ship at route/page boundaries instead. The journey stream
  // is the only thing this timer can carry, so don't even arm it when session
  // streaming is off (the default) — otherwise it wakes twice a minute for an
  // empty payload that early-returns, burning CPU/battery for nothing.
  if (cfg.session.enabled) {
    flushTimer = setInterval(() => flushEvents({ includeVitals: false }), FLUSH_INTERVAL_MS);
  }

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
  // flushEvents finalises the outgoing route's CLS/INP (the host's
  // setRouteTemplate for the new route runs later, in a router effect, so the
  // template is still the outgoing route's here). markVitalsNavigation then
  // resets the observers so the new route starts measuring from zero.
  const onNavigation = () => {
    flushEvents();
    markVitalsNavigation();
  };
  onAfterNavigation(onNavigation);
  // hashchange covers hash-router SPAs, which change the route without
  // pushState/popstate. Gate on the `#/` and `#!/` (shebang) conventions so an
  // in-page anchor jump (`#section`) isn't mistaken for a route change — that
  // would wrongly finalize and reset the current route's CLS/INP. Bare
  // `#route` hash routers are indistinguishable from anchors and aren't covered.
  const onHashChange = () => {
    if (location.hash.startsWith("#/") || location.hash.startsWith("#!/")) onNavigation();
  };
  window.addEventListener("hashchange", onHashChange);
  lifecycleUnsubscribers.push(() => window.removeEventListener("hashchange", onHashChange));
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
  // pagehide, manual flush/destroy) — never on the periodic timer. CLS/INP
  // accumulate per route in the observers; finalizeRouteVitals materialises the
  // current route's value just before we drain so the boundary that triggered
  // this flush ships an up-to-date entry.
  const sendSessionStream = resolved!.session.enabled;
  const breadcrumbs = sendSessionStream ? drainBreadcrumbs() : [];
  if (includeVitals) finalizeRouteVitals();
  const vitals = includeVitals ? drainVitals() : [];

  if (breadcrumbs.length === 0 && vitals.length === 0) return;

  const payload: EventPayload = {
    type: "events",
    session: getSessionContext(),
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
