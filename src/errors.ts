import type {
  Breadcrumb,
  BrowserError,
  FrontendTransaction,
  IncomingError,
  ResolvedConfig,
  TransactionBreadcrumb,
} from "./types.js";
import { getSessionContext, getTags } from "./session.js";
import { addBreadcrumb, getErrorBreadcrumbs } from "./breadcrumbs.js";
import { sendError } from "./transport.js";
import { getRouteTemplate } from "./vitals.js";
import { scrubUrl } from "./utils.js";

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
// Query-param allowlist for scrubbing URLs that ride the error payload. The
// errors module captures `location.href` for `environment.url`; without this it
// would ship raw query params (tokens, emails, OAuth fragments) — bypassing the
// privacy gate every other capture path goes through.
let allowlist: string[] = [];

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

// Global rate limit, independent of dedupe. Dedupe only caps *identical*
// errors (5 per key); a loop emitting errors with ever-changing messages
// (counters, ids, timestamps in the text) bypasses it entirely and would
// otherwise fire one network POST per error and grow dedupeWindow without
// bound. The global cap bounds total errors entering the pipeline per window
// regardless of key — 100 / 10s is far above any sane app's real error rate
// but stops a runaway loop from making the SDK the source of the problem.
// Console-escalated errors (errors.console) share this same budget, so a very
// chatty console.error app could in theory starve genuine uncaught errors in
// the same window; the cap is high enough that this is acceptable for v1.
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW_MS = 10_000;
let rateWindowStart = 0;
let rateWindowCount = 0;

function rateLimited(now: number): boolean {
  if (now - rateWindowStart >= RATE_LIMIT_WINDOW_MS) {
    rateWindowStart = now;
    rateWindowCount = 0;
  }
  rateWindowCount++;
  return rateWindowCount > RATE_LIMIT_MAX;
}

let errorHandler: ((event: ErrorEvent) => void) | null = null;
let rejectionHandler: ((event: PromiseRejectionEvent) => void) | null = null;

export function initErrors(
  resolved: ResolvedConfig["errors"],
  queryParamsAllowlist: string[],
  version?: string,
  beforeError?: (event: IncomingError) => IncomingError | null,
): void {
  destroyErrors();

  config = resolved;
  allowlist = queryParamsAllowlist;
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
      reason instanceof Error ? reason.message : stringifyReason(reason);
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
  rateWindowStart = 0;
  rateWindowCount = 0;
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

// Guards against the one feedback loop: handleError calls console.error when
// beforeError returns a Promise (below). Without this, that call would be
// escalated back into handleError, and so on. The SDK has no other
// console.error call site, so this single flag closes the loop.
let inConsoleReport = false;

/** Escalate a `console.error(...)` call to a reported error, gated on
 * `errors.console`. Wired from the breadcrumbs console interceptor via
 * index.ts (breadcrumbs can't import errors — would be circular). */
export function reportConsoleError(error: Error): void {
  if (inConsoleReport) return;
  if (!config?.console) return;
  inConsoleReport = true;
  try {
    handleError(
      error.message,
      undefined,
      undefined,
      undefined,
      // Best-effort cosmetic cleanup: drop the SDK interceptor frames so the
      // reported stack roots at the caller. Not load-bearing — console errors
      // bypass isOwnError (see handleError's `fromConsole`), so an imperfect
      // strip only yields a slightly noisier stack, never a dropped error.
      stripLeadingSdkFrames(error.stack),
      { source: "console" },
      error.name || "console.error",
      true,
    );
  } finally {
    inConsoleReport = false;
  }
}

function stripLeadingSdkFrames(stack?: string): string | undefined {
  if (!stack) return stack;
  const lines = stack.split("\n");
  // V8 prefixes the stack with an "Error: message" header line; Firefox and
  // Safari do not — their line 0 is already the first frame. Preserve line 0
  // only when it isn't itself a frame, otherwise the leading SDK frame is never
  // stripped on non-V8 engines and isOwnError would drop the whole error.
  const hasHeader = lines.length > 0 && !isStackFrame(lines[0]);
  let i = hasHeader ? 1 : 0;
  while (i < lines.length && SDK_MARKERS.some((m) => lines[i].includes(m))) i++;
  return [...(hasHeader ? [lines[0]] : []), ...lines.slice(i)].join("\n");
}

// V8 frames read "    at fn (file:line:col)"; Firefox/Safari read
// "fn@file:line:col". A header ("Error: msg") matches neither. The @-form is
// anchored to a trailing :line:col so an "@host:port" inside a message isn't
// mistaken for a frame. Only cosmetic now (strip is best-effort), but keeps
// the reported stack clean for the common case.
function isStackFrame(line: string): boolean {
  return /^\s*at\s/.test(line) || /@.+:\d+:\d+$/.test(line.trimEnd());
}

function handleError(
  message: string,
  filename?: string,
  lineno?: number,
  colno?: number,
  stack?: string,
  context?: Record<string, unknown>,
  errorClass?: string,
  fromConsole = false,
): void {
  if (!config.enabled) return;

  // Self-protection: ignore errors thrown from our own SDK to prevent feedback
  // loops. Console-originated errors bypass this: a synthesized console error
  // is SDK-rooted (created inside the interceptor) and its stack can't be
  // parsed reliably cross-browser, so isOwnError would drop legitimate app
  // console.errors. The `inConsoleReport` reentrancy guard is the loop
  // protection for that path instead — the SDK's only console.error site (the
  // beforeError-Promise diagnostic) is wrapped by it.
  if (!fromConsole && isOwnError(filename, stack)) return;

  // Cross-origin script errors surface as an opaque "Script error." with no
  // stack and no usable location — the browser withholds the detail unless the
  // script is served with `crossorigin="anonymous"` + CORS headers. These can't
  // be symbolicated and carry zero actionable information, so drop them rather
  // than flood the stream with indistinguishable noise.
  if (message === "Script error." && !stack) return;

  // Sample rate check
  if (config.sampleRate < 1.0 && Math.random() >= config.sampleRate) return;

  // Global rate limit — checked before the beforeError hook, the error
  // breadcrumb, the O(n) dedupe scan, and the network send, so a storm caps
  // the per-error work too, not just the wire volume.
  if (rateLimited(Date.now())) return;

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
    // Guard this log so errors.console doesn't escalate the SDK's own
    // diagnostic into a captured error. Set the flag around the call regardless
    // of entry path (an uncaught/rejection error can reach here with the flag
    // still false); save/restore so a console-originated report stays guarded.
    const prev = inConsoleReport;
    inConsoleReport = true;
    try {
      // eslint-disable-next-line no-console
      console.error(
        "[appsignal] beforeError returned a Promise. Async beforeError is " +
        "not supported; the error was dropped. Move async work outside the " +
        "hook (e.g. perform it before calling captureError).",
      );
    } finally {
      inConsoleReport = prev;
    }
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

  const payload: BrowserError = {
    type: "error",
    timestamp: now,
    // Already filtered (UX-only categories excluded) and capped to 25 by
    // the error-context ring buffer in breadcrumbs.ts.
    breadcrumbs: getErrorBreadcrumbs(),
    app_version: appVersion,
    ...effective,
  };

  sendError(toFrontendTransaction(payload));

  // Session context is only consumed by subscribers, not the wire payload —
  // getSessionContext does real work (URL scrubbing, viewport/connection reads)
  // so skip it entirely when nobody's listening.
  if (errorListeners.length > 0) {
    payload.session = getSessionContext();
    for (const l of errorListeners) {
      try { l(payload); } catch { /* don't break the chain */ }
    }
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
    // Group by the host's route template (e.g. "/users/:id") when set via
    // setRouteTemplate, so ID-heavy routes don't fragment into one error group
    // per id. Falls back to the raw pathname when no template is declared.
    action: getRouteTemplate() || location.pathname,
    revision: error.app_version,
    error: {
      name: error.error_class || "Error",
      message: error.message,
      backtrace: error.stack ? error.stack.split("\n") : [],
    },
    breadcrumbs: error.breadcrumbs.map(toTransactionBreadcrumb),
    // Error tags are exactly what the host set via setTags (already coerced and
    // capped). The SDK injects no identity of its own — user identity rides the
    // session stream, not error tags; a host that wants user on errors sets it
    // explicitly via setTags.
    tags: getTags(),
    // Scrubbed through the query-param allowlist, same as every other captured
    // URL — the raw href would otherwise leak tokens / OAuth fragments here.
    environment: { url: scrubUrl(location.href, allowlist) },
    user_agent: navigator.userAgent,
  };
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

// Non-Error promise rejections (`Promise.reject({ code: 500, detail: "…" })`)
// would collapse to "[object Object]" under String() — losing all detail and
// making every distinct object rejection dedupe to the same key. JSON-stringify
// objects so the payload survives; fall back to String() for primitives and for
// values JSON can't handle (circular refs, BigInt).
function stringifyReason(reason: unknown): string {
  if (reason === null || typeof reason !== "object") return String(reason);
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
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
