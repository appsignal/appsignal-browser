import type { BrowserConfig, EventPayload, ResolvedConfig } from "./types.js";
import { resolveConfig } from "./types.js";
import { initSession, getSessionContext, setUser as sessionSetUser, clearUser as sessionClearUser, touchActivity, endSession as sessionEndSession, destroySession } from "./session.js";
import { initBreadcrumbs, addManualBreadcrumb, drainBreadcrumbs, destroyBreadcrumbs, onAfterNavigation } from "./breadcrumbs.js";
import { initErrors, reportError, destroyErrors } from "./errors.js";
import { initVitals, drainVitals, destroyVitals } from "./vitals.js";

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

const COLLECT_PATH = "/ingest/browser";
const FLUSH_INTERVAL_MS = 30_000;

export function init(config: BrowserConfig): void {
  if (initialized) return;
  initialized = true;
  clientConfig = config;
  resolved = resolveConfig(config);

  const endpoint = resolveEndpoint(config);
  initTransport(endpoint + COLLECT_PATH, config.key);
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
  flushEvents(true);
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

export function flush(): void {
  flushEvents(false);
}

/** Tear down the SDK. Flushes remaining data and stops all collection. */
export function destroy(): void {
  if (!initialized) return;
  flushEvents(true);
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
    endpoint + COLLECT_PATH,
    cfg.privacy.queryParamsAllowlist,
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

  // Periodic flush
  flushTimer = setInterval(() => flushEvents(false), FLUSH_INTERVAL_MS);

  // Flush on visibility hidden (tab switch, app backgrounded). web-vitals
  // listeners are registered first (in initVitals) so they fire before this
  // handler and populate collectedVitals before we flush.
  lifecycleUnsubscribers.push(
    onVisibilityChange((state) => {
      if (state === "hidden") flushEvents(true);
    }),
  );
  // Flush on tab close / navigation away
  lifecycleUnsubscribers.push(
    onPageHide((persisted) => {
      if (!persisted && initialized) flushEvents(true);
    }),
  );

  // Flush on SPA navigation — use breadcrumbs' central navigation hook
  // instead of wrapping history methods again. Fire *after* the hook so
  // the navigation breadcrumb (added by recordNav via onAfterNavigation)
  // lands in this flush, not the next one.
  onAfterNavigation(() => flushEvents(false));
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

function flushEvents(useBeacon: boolean): void {
  if (!initialized) return;

  const breadcrumbs = drainBreadcrumbs();
  const vitals = drainVitals();

  if (breadcrumbs.length === 0 && vitals.length === 0) return;

  const payload: EventPayload = {
    type: "events",
    session: getSessionContext(),
    breadcrumbs,
    vitals,
    app_version: clientConfig?.appVersion,
  };

  if (useBeacon) {
    sendBeaconEvents(payload);
  } else {
    sendEvents(payload);
  }
}
