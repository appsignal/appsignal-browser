import type { BrowserError, ServerConfig } from "./types.js";
import { getSessionContext } from "./session.js";
import { addBreadcrumb, getSnapshot } from "./breadcrumbs.js";
import { sendError } from "./transport.js";
import { getConsent } from "./consent.js";

// Subscribers fired after an error has cleared every gate (consent,
// sample_rate, ignoreErrors, dedupe, beforeSend) and been handed to
// transport. Other modules subscribe instead of being imperatively poked
// from inside handleError — same pattern as onConsentDenied,
// onBeforeNavigation, onAfterRequest, etc.
const errorListeners: ((event: BrowserError) => void)[] = [];

export function onErrorReported(fn: (event: BrowserError) => void): () => void {
  errorListeners.push(fn);
  return () => {
    const i = errorListeners.indexOf(fn);
    if (i >= 0) errorListeners.splice(i, 1);
  };
}

let config: ServerConfig["errors"];
let appVersion: string | undefined;
let beforeSendHook: ((event: BrowserError) => BrowserError | null) | undefined;
let ignorePatterns: (string | RegExp)[] = [];

// Error click tracking — exported so breadcrumbs can check for recent errors
let lastErrorTimestamp = 0;
export function getLastErrorTimestamp(): number {
  return lastErrorTimestamp;
}

interface DedupeEntry {
  key: string;
  count: number;
  firstSeen: number;
}

let dedupeWindow: DedupeEntry[] = [];
const DEDUPE_MAX_COUNT = 5;
const DEDUPE_WINDOW_MS = 10_000;

export function updateErrorConfig(serverConfig: ServerConfig["errors"]): void {
  config = serverConfig;
}

let errorHandler: ((event: ErrorEvent) => void) | null = null;
let rejectionHandler: ((event: PromiseRejectionEvent) => void) | null = null;

export function initErrors(
  serverConfig: ServerConfig["errors"],
  version?: string,
  beforeSend?: (event: BrowserError) => BrowserError | null,
  ignore?: (string | RegExp)[],
): void {
  destroyErrors();

  config = serverConfig;
  appVersion = version;
  beforeSendHook = beforeSend;
  ignorePatterns = ignore ?? [];

  errorHandler = (event: ErrorEvent) => {
    handleError(
      event.message,
      event.filename,
      event.lineno,
      event.colno,
      event.error?.stack,
      undefined,
      event.error?.name,
    );
  };
  window.addEventListener("error", errorHandler);

  rejectionHandler = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const message =
      reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    const errorClass = reason instanceof Error ? reason.name : undefined;
    handleError(message, undefined, undefined, undefined, stack, undefined, errorClass);
  };
  window.addEventListener("unhandledrejection", rejectionHandler);
}

export function destroyErrors(): void {
  if (errorHandler) {
    window.removeEventListener("error", errorHandler);
    errorHandler = null;
  }
  if (rejectionHandler) {
    window.removeEventListener("unhandledrejection", rejectionHandler);
    rejectionHandler = null;
  }
  dedupeWindow = [];
  lastErrorTimestamp = 0;
  errorListeners.length = 0;
}

/** Report an error through the full pipeline. Used by captureError for framework plugins. */
export function reportError(
  error: Error,
  context?: Record<string, unknown>,
): void {
  handleError(
    error.message,
    undefined,
    undefined,
    undefined,
    error.stack,
    context,
    error.name,
  );
}

function handleError(
  message: string,
  filename?: string,
  lineno?: number,
  colno?: number,
  stack?: string,
  context?: Record<string, unknown>,
  errorClass?: string,
): void {
  if (!config.enabled) return;
  if (getConsent() === "not-granted") return;

  // Self-protection: ignore errors from our own SDK to prevent feedback loops
  if (isOwnError(filename, stack)) return;

  // Sample rate check
  if (config.sample_rate < 1.0 && Math.random() >= config.sample_rate) return;

  // ignoreErrors filter
  if (shouldIgnore(message)) return;

  const now = Date.now();
  lastErrorTimestamp = now;

  // Error breadcrumb
  addBreadcrumb({
    timestamp: now,
    category: "error",
    message: message.slice(0, 200),
  });

  // Deduplication: first 5 occurrences sent, 6+ suppressed
  const dedupeKey = dedupeKeyFor(message, stack);
  if (checkDedupe(dedupeKey, now)) return;

  let payload: BrowserError | null = {
    type: "error",
    timestamp: now,
    message,
    error_class: errorClass,
    filename,
    lineno,
    colno,
    stack,
    breadcrumbs: getSnapshot(),
    session: getSessionContext(),
    app_version: appVersion,
    context,
  };

  // beforeSend hook — runs before subscribers so a dropped error doesn't
  // trigger downstream side effects (e.g. replay shipping its post-error
  // tail for an error the user explicitly suppressed).
  if (beforeSendHook) {
    const result = beforeSendHook(payload);
    // beforeSend is sync only. A Promise return would otherwise sail through
    // the truthy check and JSON.stringify into `{}` on the wire — silent
    // empty payloads. Detect it, drop the error, and log loudly so a host
    // developer can grep for the message.
    if (result && typeof (result as { then?: unknown }).then === "function") {
      // eslint-disable-next-line no-console
      console.error(
        "[appsignal] beforeSend returned a Promise. Async beforeSend is not " +
        "supported; the error was dropped. Move async work outside the hook " +
        "(e.g. perform it before calling captureError).",
      );
      return;
    }
    if (!result) return;
    payload = result;
  }

  sendError(payload);

  for (const l of errorListeners) {
    try { l(payload); } catch { /* don't break the chain */ }
  }
}

const SDK_MARKERS = ["@appsignal/browser", "browser.umd.js", "browser.esm.js"];

function isOwnError(filename?: string, stack?: string): boolean {
  const haystack = (filename || "") + (stack || "");
  return SDK_MARKERS.some((marker) => haystack.includes(marker));
}

function shouldIgnore(message: string): boolean {
  return ignorePatterns.some((pattern) => {
    if (typeof pattern === "string") {
      return message.includes(pattern);
    }
    return pattern.test(message);
  });
}

function dedupeKeyFor(message: string, stack?: string): string {
  const frames = stack?.split("\n").slice(1, 4).map(f => f.trim()).join("|") || "";
  return `${message}|${frames}`;
}

function checkDedupe(key: string, now: number): boolean {
  // Clean old entries
  while (dedupeWindow.length > 0 && now - dedupeWindow[0].firstSeen > DEDUPE_WINDOW_MS) {
    dedupeWindow.shift();
  }

  const existing = dedupeWindow.find((e) => e.key === key);
  if (existing) {
    existing.count++;
    // First 5 occurrences are sent, 6+ are suppressed
    return existing.count > DEDUPE_MAX_COUNT;
  }

  dedupeWindow.push({ key, count: 1, firstSeen: now });
  return false;
}
