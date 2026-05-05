import type { BrowserConfig, ServerConfig, EventPayload } from "./types.js";
import { DEFAULT_SERVER_CONFIG } from "./types.js";
import { initSession, getSessionId, getTabId, getSessionContext, setUser as sessionSetUser, clearUser as sessionClearUser, touchActivity, endSession as sessionEndSession, destroySession } from "./session.js";
import { initBreadcrumbs, updateBreadcrumbConfig, addManualBreadcrumb, drainBreadcrumbs, clearBreadcrumbs, destroyBreadcrumbs, onAfterNavigation } from "./breadcrumbs.js";
import { initErrors, updateErrorConfig, reportError, destroyErrors } from "./errors.js";
import { initVitals, drainVitals, destroyVitals } from "./vitals.js";
import { initReplay, applyReplaySampling, destroyReplay, discardReplay, flushReplay, clearChunkIndex } from "./replay.js";

import { initTransport, sendEvents, sendBeaconEvents, destroyTransport } from "./transport.js";
import { initTracing, destroyTracing } from "./tracing.js";
import { setConsent as setConsentState, getConsent, onConsentDenied, destroyConsent } from "./consent.js";
import type { ConsentState } from "./consent.js";

export type { BrowserConfig } from "./types.js";

let clientConfig: BrowserConfig | null = null;
let serverConfig: ServerConfig = DEFAULT_SERVER_CONFIG;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let initialized = false;

// Original references for teardown
let visibilityHandler: (() => void) | null = null;
let pagehideHandler: EventListener | null = null;

const COLLECT_PATH = "/ingest/browser";
const CONFIG_PATH = "/ingest/browser/config";
const FLUSH_INTERVAL_MS = 30_000;

export function init(config: BrowserConfig): void {
  if (initialized) return;
  initialized = true;
  clientConfig = config;

  // Set initial consent state (default: granted for backwards compatibility)
  setConsentState(config.trackingConsent ?? "granted");

  const endpoint = resolveEndpoint(config);
  initTransport(endpoint + COLLECT_PATH, config.key);

  // Start all collectors including replay with the fallback config.
  // The fallback has replay sample_rate 1.0 so everything is recorded.
  // The server config narrows what gets kept.
  startCollection(endpoint);

  // Fetch server config and apply it — guard against destroy() during fetch
  fetchServerConfig(endpoint, config.key).then((cfg) => {
    if (!initialized) return;
    applyServerConfig(cfg);
  });
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
  // Snapshot the current session_id first — touchActivity below may itself
  // rotate the session if the inactivity window has already elapsed (app
  // woke from long sleep). In that case the buffered events we're about to
  // flush get attributed to the fresh session, not the one the caller
  // meant to end; accept this as the documented behavior. The subsequent
  // touchActivity keeps getSessionId() inside flushEvents/flushReplay
  // from rotating again mid-flush.
  const sessionIdToClear = getSessionId();
  const tabIdToClear = getTabId();
  touchActivity();
  flushEvents(true);
  flushReplay(true);
  clearChunkIndex(sessionIdToClear, tabIdToClear);
  sessionEndSession();
}

export function setConsent(consent: ConsentState): void {
  setConsentState(consent);
}

/** Report a caught error manually. Used by framework plugins and try/catch blocks. */
export function captureError(
  error: Error,
  context?: { componentName?: string; [key: string]: unknown },
): void {
  if (!initialized) return;
  reportError(error, context);
}

export function addBreadcrumb(crumb: {
  category: string;
  message: string;
  data?: Record<string, unknown>;
}): void {
  if (!initialized) return;
  addManualBreadcrumb(crumb);
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
  destroyConsent();
  destroyTransport();
  initialized = false;
  clientConfig = null;
  serverConfig = DEFAULT_SERVER_CONFIG;
}

// --- Internal ---

function resolveEndpoint(config: BrowserConfig): string {
  if (config.endpoint) return config.endpoint.replace(/\/$/, "");
  return location.origin;
}

async function fetchServerConfig(
  endpoint: string,
  key: string,
): Promise<ServerConfig> {
  try {
    const url = `${endpoint}${CONFIG_PATH}?key=${encodeURIComponent(key)}`;
    const response = await fetch(url);
    if (!response.ok) return DEFAULT_SERVER_CONFIG;
    return await response.json();
  } catch {
    return DEFAULT_SERVER_CONFIG;
  }
}

function startCollection(endpoint: string): void {
  const cfg = DEFAULT_SERVER_CONFIG;

  initSession(cfg.session.inactivity_timeout_ms);
  initBreadcrumbs(cfg.breadcrumbs, endpoint + COLLECT_PATH);
  initErrors(
    cfg.errors,
    clientConfig?.appVersion,
    clientConfig?.beforeSend,
    clientConfig?.ignoreErrors,
  );

  if (clientConfig?.tracePropagationTargets?.length) {
    initTracing(clientConfig.tracePropagationTargets);
  }

  initVitals(cfg.breadcrumbs.query_params_allowlist);
  initReplay(cfg.replay, clientConfig?.appVersion);

  // When consent is denied, clear collected breadcrumbs
  onConsentDenied(() => {
    clearBreadcrumbs();
  });

  // Periodic flush
  flushTimer = setInterval(() => flushEvents(false), FLUSH_INTERVAL_MS);

  // Flush on visibility hidden (tab switch, app backgrounded).
  // web-vitals listeners are registered first (in initVitals), so they
  // fire before this handler and populate collectedVitals before we flush.
  // LCP, CLS, and INP all use `reportAllChanges: true` so each value is
  // pushed as it updates rather than deferred to pagehide — web-vitals'
  // default finalisers run via `requestIdleCallback` which doesn't complete
  // before page unload and would otherwise lose the final value.
  visibilityHandler = () => {
    if (document.visibilityState === "hidden") {
      flushEvents(true);
    }
  };
  document.addEventListener("visibilitychange", visibilityHandler);

  // Flush on tab close / navigation away
  pagehideHandler = (e: Event) => {
    if (!(e as PageTransitionEvent).persisted && initialized) {
      flushEvents(true);
    }
  };
  window.addEventListener("pagehide", pagehideHandler);

  // Flush on SPA navigation — use breadcrumbs' central navigation hook
  // instead of wrapping history methods again. Fire *after* the hook so
  // the navigation breadcrumb (added by recordNav via onAfterNavigation)
  // lands in this flush, not the next one.
  onAfterNavigation(() => flushEvents(false));
}

function applyServerConfig(cfg: ServerConfig): void {
  serverConfig = cfg;
  if (!cfg.enabled) {
    // Discard replay buffer before stopCollection (which would flush it)
    discardReplay();
    clearBreadcrumbs();
    stopCollection();
    return;
  }
  // Propagate real config to all modules
  updateBreadcrumbConfig(cfg.breadcrumbs);
  updateErrorConfig(cfg.errors);
  applyReplaySampling(cfg.replay);
}

function stopCollection(): void {
  // Order matters: breadcrumbs before tracing (unwinding patch chain)
  destroyReplay();
  destroyBreadcrumbs();
  destroyTracing();
  destroyErrors();
  destroyVitals();

  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  if (visibilityHandler) {
    document.removeEventListener("visibilitychange", visibilityHandler);
    visibilityHandler = null;
  }
  if (pagehideHandler) {
    window.removeEventListener("pagehide", pagehideHandler);
    pagehideHandler = null;
  }
}

function flushEvents(useBeacon: boolean): void {
  if (!initialized || !serverConfig.enabled) return;
  if (getConsent() === "not-granted") return;

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
