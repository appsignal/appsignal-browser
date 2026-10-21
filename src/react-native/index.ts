import type { BreadcrumbsConfig, BrowserConfig, PrivacyConfig, ResolvedConfig, UserContext } from "../types.js";
import { resolveConfig } from "../types.js";
import { setRuntime } from "../runtime.js";
import { reactNativeRuntime } from "./runtime.js";
import { initSession, setUser as sessionSetUser, clearUser as sessionClearUser, setTags as sessionSetTags, clearTags as sessionClearTags, stopSessionTracking } from "../session.js";
import { initBreadcrumbs, addManualBreadcrumb, destroyBreadcrumbs } from "../breadcrumbs.js";
import { initErrors, reportError, destroyErrors } from "../errors.js";
import { setRouteTemplate as setVitalsRouteTemplate, destroyVitals } from "../vitals.js";
import { initTransport, destroyTransport, EVENTS_PATH, ERROR_PATH } from "../transport.js";
import { initNetworkHook, destroyNetworkHook } from "../network-hook.js";
import { destroyLifecycle } from "../lifecycle.js";
import { logError, attemptCleanup } from "../utils.js";

export type { Breadcrumb, IncomingError, UserContext } from "../types.js";

/** Configuration for React Native. The options the browser SDK derives from
 * the page (clicks, web vitals, DOM privacy, session streaming) do not apply. */
export interface ReactNativeConfig extends Pick<
  BrowserConfig,
  "key" | "endpoint" | "active" | "appVersion" | "serviceName" | "beforeError" | "beforeBreadcrumb" | "errors"
> {
  breadcrumbs?: Pick<BreadcrumbsConfig, "network" | "console">;
  privacy?: Pick<PrivacyConfig, "queryParamsAllowlist" | "networkBlocklist">;
}

const DEFAULT_ENDPOINT = "https://appsignal-endpoint.net";
const DEFAULT_SERVICE_NAME = "React Native";

let resolved: ResolvedConfig | null = null;
let initialized = false;

export function init(config: ReactNativeConfig): void {
  if (initialized) return;

  try {
    if (config.active === false) return;

    setRuntime(reactNativeRuntime);
    resolved = resolveConfig({ ...config, serviceName: config.serviceName || DEFAULT_SERVICE_NAME });
    const endpoint = (config.endpoint || DEFAULT_ENDPOINT).replace(/\/$/, "");
    initTransport(endpoint, config.key);
    startCollection(config, endpoint);
  } catch (error) {
    detachAll();
    logError("init failed; the SDK is inactive", error);
    return;
  }

  initialized = true;
}

export const setUser = /* @__PURE__ */ guard("setUser", (user: UserContext): void => {
  sessionSetUser(user);
});

export const clearUser = /* @__PURE__ */ guard("clearUser", (): void => {
  sessionClearUser();
});

export const setTags = /* @__PURE__ */ guard("setTags", (tags: Record<string, unknown>): void => {
  sessionSetTags(tags);
});

export const clearTags = /* @__PURE__ */ guard("clearTags", (): void => {
  sessionClearTags();
});

/** Report a caught error. */
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

/** Name the screen the user is on, such as a route name from React Navigation
 * or a path from Expo Router. Errors group by it. Pass `null` to clear. */
export const setRouteTemplate = /* @__PURE__ */ guard("setRouteTemplate", (template: string | null): void => {
  setVitalsRouteTemplate(template);
});

/** Tear down the SDK and stop all collection. */
export const destroy = /* @__PURE__ */ guard("destroy", (): void => {
  initialized = false;
  detachAll();
});

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

function startCollection(config: ReactNativeConfig, endpoint: string): void {
  const cfg = resolved!;
  initSession(cfg.session.inactivityTimeoutMs, cfg.privacy.queryParamsAllowlist);
  initNetworkHook();
  initBreadcrumbs(
    cfg.breadcrumbs,
    [endpoint + EVENTS_PATH, endpoint + ERROR_PATH],
    cfg.privacy.queryParamsAllowlist,
    cfg.privacy.networkBlocklist,
    cfg.privacy.dom,
    config.beforeBreadcrumb,
  );
  initErrors(
    cfg.errors,
    cfg.privacy.queryParamsAllowlist,
    config.appVersion,
    config.beforeError,
    cfg.serviceName,
    cfg.privacy.networkBlocklist,
  );
}

function detachAll(): void {
  attemptCleanup("breadcrumbs", destroyBreadcrumbs);
  attemptCleanup("errors", destroyErrors);
  attemptCleanup("route template", destroyVitals);
  attemptCleanup("network hook", destroyNetworkHook);
  attemptCleanup("session tracking", stopSessionTracking);
  attemptCleanup("lifecycle", destroyLifecycle);
  attemptCleanup("transport", destroyTransport);
  resolved = null;
}
