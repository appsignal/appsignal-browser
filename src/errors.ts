import type {
  Breadcrumb,
  BrowserError,
  FrontendTransaction,
  IncomingError,
  ResolvedConfig,
  TransactionBreadcrumb,
} from "./types.js";
import { getSessionContext, getUser } from "./session.js";
import { addBreadcrumb, getErrorBreadcrumbs } from "./breadcrumbs.js";
import { sendError } from "./transport.js";

// Subscribers fired after an error has cleared every gate (sample_rate,
// beforeError, dedupe) and been handed to transport. Other modules
// subscribe instead of being imperatively poked from inside handleError —
// same pattern as onBeforeNavigation, onAfterRequest, etc.
const errorListeners: ((event: BrowserError) => void)[] = [];

export function onErrorReported(fn: (event: BrowserError) => void): () => void {
  errorListeners.push(fn);
  return () => {
    const i = errorListeners.indexOf(fn);
    if (i >= 0) errorListeners.splice(i, 1);
  };
}

let config: ResolvedConfig["errors"];
let appVersion: string | undefined;
let beforeErrorHook: ((event: IncomingError) => IncomingError | null) | undefined;

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

let errorHandler: ((event: ErrorEvent) => void) | null = null;
let rejectionHandler: ((event: PromiseRejectionEvent) => void) | null = null;

export function initErrors(
  resolved: ResolvedConfig["errors"],
  version?: string,
  beforeError?: (event: IncomingError) => IncomingError | null,
): void {
  destroyErrors();

  config = resolved;
  appVersion = version;
  beforeErrorHook = beforeError;

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

  // Self-protection: ignore errors from our own SDK to prevent feedback loops
  if (isOwnError(filename, stack)) return;

  // Sample rate check
  if (config.sampleRate < 1.0 && Math.random() >= config.sampleRate) return;

  // beforeError hook — early-pipeline. Runs before any side effect (error
  // breadcrumb, lastErrorTimestamp, dedupe slot, payload construction,
  // replay post-error tail). Returning null drops the error completely:
  // no breadcrumb pollution, no dedupe budget consumed, no replay
  // triggered. Mutating fields on the returned object propagates into the
  // eventual payload.
  const incoming: IncomingError = {
    message,
    error_class: errorClass,
    filename,
    lineno,
    colno,
    stack,
    context,
  };
  const hookResult = beforeErrorHook ? beforeErrorHook(incoming) : incoming;

  // beforeError is sync only. A Promise return would otherwise pass the
  // truthy check and the SDK would proceed treating the Promise as fields —
  // silent breakage. Detect it, drop the error, and log loudly so a host
  // developer can grep for the message.
  if (hookResult && typeof (hookResult as { then?: unknown }).then === "function") {
    // eslint-disable-next-line no-console
    console.error(
      "[appsignal] beforeError returned a Promise. Async beforeError is " +
      "not supported; the error was dropped. Move async work outside the " +
      "hook (e.g. perform it before calling captureError).",
    );
    return;
  }
  if (!hookResult) return;
  const effective: IncomingError = hookResult;

  const now = Date.now();
  lastErrorTimestamp = now;

  // Error breadcrumb
  addBreadcrumb({
    timestamp: now,
    category: "error",
    message: effective.message.slice(0, 200),
  });

  // Deduplication: first 5 occurrences sent, 6+ suppressed
  const dedupeKey = dedupeKeyFor(effective.message, effective.stack);
  if (checkDedupe(dedupeKey, now)) return;

  const session = getSessionContext();
  const payload: BrowserError = {
    type: "error",
    timestamp: now,
    // Already filtered (UX-only categories excluded) and capped to 25 by
    // the error-context ring buffer in breadcrumbs.ts.
    breadcrumbs: getErrorBreadcrumbs(),
    session,
    app_version: appVersion,
    ...effective,
  };

  sendError(toFrontendTransaction(payload));

  for (const l of errorListeners) {
    try { l(payload); } catch { /* don't break the chain */ }
  }
}

// Map our internal BrowserError to the AppSignal `FrontendTransaction` wire
// shape consumed by the processor's frontend_errors pipeline. `revision` is
// the matchup key with sourcemaps uploaded out-of-band (S3 keyed by
// site_id + revision); without it stacks land unsymbolicated.
function toFrontendTransaction(error: BrowserError): FrontendTransaction {
  return {
    // Server expects unix seconds, not milliseconds.
    timestamp: Math.floor(error.timestamp / 1000),
    namespace: "browser",
    // No router integration yet; fall back to the raw pathname.
    action: location.pathname,
    revision: error.app_version,
    error: {
      name: error.error_class || "Error",
      message: error.message,
      backtrace: error.stack ? error.stack.split("\n") : [],
    },
    breadcrumbs: error.breadcrumbs.map(toTransactionBreadcrumb),
    tags: userTags(),
    environment: { url: location.href },
    user_agent: navigator.userAgent,
  };
}

// Error tags are exactly the attributes the host set via setUser (id, email,
// name, and any custom fields), passed through verbatim. The SDK adds no
// identity of its own: session/tab/anonymous ids aren't in the server's
// metadata-distribution allowlist, so they'd just be high-cardinality sample
// noise. Undefined/empty values are skipped; the rest are coerced to strings
// (the server truncates each to 256 bytes).
function userTags(): Record<string, string> {
  const user = getUser();
  if (!user) return {};
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(user)) {
    if (value != null && value !== "") tags[key] = String(value);
  }
  return tags;
}

function toTransactionBreadcrumb(b: Breadcrumb): TransactionBreadcrumb {
  const data = b.data ?? {};
  return {
    timestamp: Math.floor(b.timestamp / 1000),
    category: b.category,
    action: actionForBreadcrumb(b.category, data),
    message: b.message,
    metadata: data,
  };
}

// `action` on a breadcrumb is a category-specific primary identifier. For
// clicks it's the CSS selector; for navigation it's the destination URL;
// for network/request it's the request URL; and so on. We pick from the
// breadcrumb's `data` rather than introducing new fields at capture time.
function actionForBreadcrumb(
  category: string,
  data: Record<string, unknown>,
): string {
  switch (category) {
    case "navigation":
      return String(data.to ?? data.url ?? "");
    case "click":
    case "rage_click":
    case "dead_click":
    case "error_click":
      return String(data.selector ?? "");
    case "network":
      return String(data.url ?? "");
    case "console":
      return String(data.level ?? "");
    case "visibility":
    case "tab":
      return String(data.state ?? "");
    default:
      // Includes "error", "long_task", "scroll_depth", and manual
      // breadcrumbs. Manual callers can put their own primary identifier
      // under `data.action` if they have one.
      return String(data.action ?? "");
  }
}

const SDK_MARKERS = ["@appsignal/browser", "browser.umd.js", "browser.esm.js"];

function isOwnError(filename?: string, stack?: string): boolean {
  const haystack = (filename || "") + (stack || "");
  return SDK_MARKERS.some((marker) => haystack.includes(marker));
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
