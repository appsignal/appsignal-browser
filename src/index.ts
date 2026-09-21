import type { BrowserConfig, EventPayload, ResolvedConfig, UserContext } from "./types.js";
import { resolveConfig } from "./types.js";
import { initSession, getSessionContext, setUser as sessionSetUser, clearUser as sessionClearUser, setTags as sessionSetTags, clearTags as sessionClearTags, touchActivity, endSession as sessionEndSession, stopSessionTracking } from "./session.js";
import { initBreadcrumbs, addManualBreadcrumb, drainBreadcrumbs, destroyBreadcrumbs, onAfterNavigation } from "./breadcrumbs.js";
import { initErrors, reportError, destroyErrors } from "./errors.js";
import { initVitals, drainVitals, finalizeRouteVitals, destroyVitals, markVitalsNavigation, setRouteTemplate as setVitalsRouteTemplate, getRouteAction } from "./vitals.js";

import { initTransport, sendEvents, sendBeaconEvents, destroyTransport, EVENTS_PATH, ERROR_PATH } from "./transport.js";
import { initTracing, markTracingNavigation, destroyTracing } from "./tracing.js";
import { initNetworkHook, destroyNetworkHook } from "./network-hook.js";
import { onVisibilityChange, onPageHide, destroyLifecycle } from "./lifecycle.js";
import { logError, attemptCleanup } from "./utils.js";

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

  try {
    // Keep every config read inside the boundary: JavaScript callers can pass
    // a malformed value, and a config property can itself be a throwing getter.
    // Neither should escape from this public entry point.
    if (config.active === false) return;

    clientConfig = config;
    resolved = resolveConfig(config);

    const endpoint = resolveEndpoint(config);
    initTransport(endpoint, config.key, config.tracing?.endpoint);
    startCollection(endpoint);
  } catch (error) {
    // Hosts import this module at the top of their entry bundle, so a throw
    // here runs before their own code and takes the page down with it. The
    // flag stays down, so every public method no-ops instead of running
    // against state that startCollection never finished to build.
    detachAll();
    logError("init failed; the SDK is inactive", error);
    return;
  }

  initialized = true;
}

/** Identify the current user (`id`, `email`, `name`). Rides the session/journey
 * stream as user context. Does not tag errors — for error-filtering metadata
 * (and to put user info on errors), use {@link setTags}. Call {@link clearUser}
 * on logout to drop identity. */
export const setUser = /* @__PURE__ */ guard("setUser", (user: UserContext): void => {
  sessionSetUser(user);
});

export const clearUser = /* @__PURE__ */ guard("clearUser", (): void => {
  sessionClearUser();
});

/** Attach arbitrary string tags to every subsequent error payload, for
 * filtering/searching errors in the UI — e.g.
 * `setTags({ plan: "pro", org_id: "acme" })`. Merges with any existing tags;
 * pass an empty value to drop a key. Values are coerced to strings and the set
 * is capped. Use {@link clearTags} to reset. */
export const setTags = /* @__PURE__ */ guard("setTags", (tags: Record<string, unknown>): void => {
  sessionSetTags(tags);
});

export const clearTags = /* @__PURE__ */ guard("clearTags", (): void => {
  sessionClearTags();
});

/** End the current browser session. Flushes pending events and replay chunks
 * under the current session_id, then clears session and user state so the next
 * captured event starts a fresh session. Typical use: call on user logout —
 * the flush uses sendBeacon since logout is often followed immediately by a
 * navigation that would cancel a plain fetch. */
export const endSession = /* @__PURE__ */ guard("endSession", (): void => {
  // touchActivity below may rotate the session if the inactivity window has
  // already elapsed (app woke from long sleep). In that case the buffered
  // events we're about to flush get attributed to the fresh session, not
  // the one the caller meant to end; accept this as the documented behavior.
  // The subsequent touchActivity keeps getSessionId() inside flushEvents
  // from rotating again mid-flush.
  try {
    touchActivity();
    flushEvents({ beacon: true });
  } finally {
    // Logout semantics are more important than the best-effort final flush:
    // never retain the old identity because a browser API rejected the send.
    sessionEndSession();
  }
});

/** Report a caught error manually. Used by framework plugins and try/catch blocks. */
export const captureError = /* @__PURE__ */ guard("captureError", (
  error: Error,
  context?: { componentName?: string; [key: string]: unknown },
): void => {
  reportError(error, context);
});

export const addBreadcrumb = /* @__PURE__ */ guard("addBreadcrumb", (breadcrumb: {
  category: string;
  message: string;
  data?: Record<string, unknown>;
}): void => {
  addManualBreadcrumb(breadcrumb);
});

/** Tell the SDK which route template the user is currently on — typically
 * a router-shaped string like `/users/:id` or `/orders/[id]/items`.
 *
 * Subsequent web-vital measurements are stamped with this template so the
 * server can aggregate by route instead of by raw URL. Persists until the
 * next call. Pass `null` to clear.
 *
 * The SDK removes the spaces around the template and its trailing slash, so
 * `/checkout` and `/checkout/` give one page.
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
export const setRouteTemplate = /* @__PURE__ */ guard("setRouteTemplate", (template: string | null): void => {
  setVitalsRouteTemplate(template);
});

export const flush = /* @__PURE__ */ guard("flush", (): void => {
  flushEvents();
});

/** Tear down the SDK. Flushes remaining data and stops all collection. */
export const destroy = /* @__PURE__ */ guard("destroy", (): void => {
  try {
    flushEvents({ beacon: true });
  } finally {
    // Disable callbacks before detaching them. Even if the final flush or an
    // individual cleanup fails, destroy still leaves the SDK inert.
    initialized = false;
    detachAll();
    // Unlike a rollback, an explicit destroy ends the visitor's session.
    attemptCleanup("session", sessionEndSession);
  }
});

// --- Internal ---

/** Wrap a public entry point. It is inert until init succeeds, and nothing it
 * does can throw into the host page: the host calls these from its own code
 * paths, a React render, a router effect, a catch block, and a failure inside
 * the SDK is the SDK's problem.
 *
 * `init` is not wrapped: it needs its own handler, to roll back what it built.
 * Registered callbacks and listeners are guarded where they are dispatched. */
function guard<A extends unknown[]>(name: string, fn: (...args: A) => void): (...args: A) => void {
  return (...args: A): void => {
    if (!initialized) return;
    try {
      fn(...args);
    } catch (error) {
      logError(`${name} failed`, error);
    }
  };
}

/** Undo what init built: patched fetch/XHR, listeners, observers, timers.
 * Each step is guarded on its own, so a throw in one still leaves the rest
 * torn down. The visitor's stored session, user and tags survive: they are not
 * this page load's to delete. `destroy` ends them separately. */
function detachAll(): void {
  attemptCleanup("collection", stopCollection);
  attemptCleanup("session tracking", stopSessionTracking);
  attemptCleanup("transport", destroyTransport);
  clientConfig = null;
  resolved = null;
}

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
    // The SDK's own posts. Without the tracing here it instruments itself,
    // and its trace post becomes the last request before every error.
    [
      endpoint + EVENTS_PATH,
      endpoint + ERROR_PATH,
      ...(clientConfig?.tracing ? [clientConfig.tracing.endpoint] : []),
    ],
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
    clientConfig?.tracing,
  );

  if (clientConfig?.tracePropagationTargets?.length) {
    initTracing(clientConfig.tracePropagationTargets, getRouteAction);
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
  //
  // Gate on an actual route change (pathname+hash) so same-path updates (the
  // router's initial URL normalization, query-only changes) aren't treated as a
  // route boundary.
  const routeKey = () => location.pathname + location.hash;
  let lastRouteKey = routeKey();
  const onNavigation = () => {
    const key = routeKey();
    if (key === lastRouteKey) return;
    lastRouteKey = key;
    flushEvents();
    markVitalsNavigation();
    markTracingNavigation();
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
  attemptCleanup("tracing", destroyTracing);
  attemptCleanup("breadcrumbs", destroyBreadcrumbs);
  attemptCleanup("errors", destroyErrors);
  attemptCleanup("vitals", destroyVitals);
  attemptCleanup("network hook", destroyNetworkHook);

  if (flushTimer) {
    const timer = flushTimer;
    flushTimer = null;
    attemptCleanup("flush timer", () => clearInterval(timer));
  }
  const unsubscribers = lifecycleUnsubscribers;
  lifecycleUnsubscribers = [];
  for (const unsub of unsubscribers) attemptCleanup("lifecycle subscription", unsub);
  attemptCleanup("lifecycle", destroyLifecycle);
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
