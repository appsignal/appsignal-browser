import type { BrowserError, ServerConfig } from "./types.js";
import { getSessionContext } from "./session.js";
import { addBreadcrumb, getSnapshot } from "./breadcrumbs.js";
import { sendError } from "./transport.js";
import { onError as notifyReplay } from "./replay.js";
import { getConsent } from "./consent.js";

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

const dedupeWindow: DedupeEntry[] = [];
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
  // Make init idempotent: a second init must not stack listeners or carry
  // dedupe state from the previous instance (HMR, tests, double-init).
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
  dedupeWindow.length = 0;
  lastErrorTimestamp = 0;
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

  // Notify replay that an error occurred
  notifyReplay();

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

  // beforeSend hook
  if (beforeSendHook) {
    const result = beforeSendHook(payload);
    if (!result) return;
    payload = result;
  }

  sendError(payload);
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
