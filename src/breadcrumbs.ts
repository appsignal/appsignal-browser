import type { Breadcrumb, ResolvedConfig } from "./types.js";
import { RingBuffer } from "./ring-buffer.js";
import { touchActivity } from "./session.js";
import { getLastErrorTimestamp } from "./errors.js";
import { consumeTraceId } from "./tracing.js";
import { safeUrl, globMatch, scrubUrl, timeOrigin, errorLike } from "./utils.js";
import { onAfterRequest, type RequestResult } from "./network-hook.js";
import { onVisibilityChange, onPageHide } from "./lifecycle.js";

// Two parallel ring buffers, split at write time:
//
// - sessionBuffer holds *everything* up to 100 entries. It drains on every
//   events flush and represents the full user-activity stream the server
//   needs to reconstruct journeys.
// - errorBuffer holds *only debug-relevant* categories up to 25 entries.
//   It's snapshotted (not drained) every time an error fires. Pre-filtering
//   at push time keeps fresh useful context in the buffer even when noisy
//   UX-derived categories (rage_click, scroll_depth, …) dominate the page.
//
// The capacities and allowlist are hardcoded; we don't expose them as
// config because there are no good knobs for an end-user to pick from.
const SESSION_BUFFER_CAPACITY = 100;
const ERROR_BUFFER_CAPACITY = 25;
// Allowlist (not denylist) so any new SDK-emitted category defaults to
// "session-only" until it's explicitly proven useful for error context.
// `addManualBreadcrumb` bypasses this check — host-supplied breadcrumbs
// are inherently intentional debugging context.
const ERROR_BUFFER_CATEGORIES: ReadonlySet<string> = new Set([
  "navigation",
  "click",
  "network",
  "console",
  "error",
  "long_task",
  "visibility",
]);

let sessionBuffer = new RingBuffer<Breadcrumb>(SESSION_BUFFER_CAPACITY);
let errorBuffer = new RingBuffer<Breadcrumb>(ERROR_BUFFER_CAPACITY);
let config: ResolvedConfig["breadcrumbs"];
let beforeBreadcrumbHook: ((breadcrumb: Breadcrumb) => Breadcrumb | null) | undefined;
let queryParamsAllowlist: string[] = [];
let networkBlocklist: string[] = [];
// Pre-joined selectors so the hot path (every click) doesn't reformat them.
// `null` means the list is empty — skip the el.closest() check entirely.
let maskTextSelector: string | null = null;
let blockElementSelector: string | null = null;
// All SDK-internal POST destinations (events + errors). The network
// breadcrumb collector skips any URL that contains one of these so the
// SDK's own requests don't show up as breadcrumbs in their own payload.
let internalEndpoints: string[] = [];

function setPrivacyDom(dom: ResolvedConfig["privacy"]["dom"]): void {
  maskTextSelector = dom.maskText.length ? dom.maskText.join(", ") : null;
  blockElementSelector = dom.blockElement.length
    ? dom.blockElement.join(", ")
    : null;
}

// Original references for patching
let origConsoleWarn: typeof console.warn;
let origConsoleError: typeof console.error;

// Escalation hook: when set (errors.console enabled), console.error calls are
// forwarded here to be reported as errors. Wired from index.ts to the errors
// module — breadcrumbs can't import errors directly (circular).
let onConsoleError: ((error: Error) => void) | undefined;

// Cleanup functions for all observers, listeners, and patches
let cleanups: (() => void)[] = [];

// ── Central navigation hook ──────────────────────────────────────────────
// Single set of pushState/replaceState/popstate patches. Features register
// callbacks instead of each patching history methods independently.
//
// We capture pushState at patch time (not module load) and delegate to it, so we
// compose with a foreign patch (e.g. a router that also wraps pushState) rather
// than orphaning it and breaking SPA navigation. The wrapper is tagged so
// reinit/HMR unwraps instead of chaining, and destroy restores the captured
// previous handler, not native.

type NavPatchedFn<T> = T & { __appsignalOrig?: T };

const NAV_METHODS = ["pushState", "replaceState"] as const;

let preNavListeners: (() => void)[] = [];
let postNavListeners: (() => void)[] = [];
let navigationHookInstalled = false;
let popstateHandler: (() => void) | null = null;
// Bumped on every (re)install; a wrapper only dispatches while its generation is
// current, so a stale wrapper we couldn't unwrap degrades to a pass-through
// instead of double-firing. Each destroy→init cycle behind a foreign patch
// therefore leaves one inert layer in the chain — call depth, not a leak.
let navGeneration = 0;

/** Register a callback that fires before pushState/replaceState (for flushing state). */
export function onBeforeNavigation(fn: () => void): void {
  preNavListeners.push(fn);
  ensureNavigationHook();
}

/** Register a callback that fires after pushState/replaceState (for recording new URL). */
export function onAfterNavigation(fn: () => void): void {
  postNavListeners.push(fn);
  ensureNavigationHook();
}

function ensureNavigationHook(): void {
  if (navigationHookInstalled) return;
  navigationHookInstalled = true;
  const generation = ++navGeneration;
  const dispatchPre = () => {
    if (generation !== navGeneration) return;
    for (const fn of preNavListeners) fn();
  };
  const dispatchPost = () => {
    if (generation !== navGeneration) return;
    for (const fn of postNavListeners) fn();
  };

  // Delegate to whatever is installed now; unwrap our own wrapper (HMR) so we
  // don't chain. pushState and replaceState have the same signature, so one
  // installer covers both.
  for (const method of NAV_METHODS) {
    const current = history[method] as NavPatchedFn<History["pushState"]>;
    const previous = current.__appsignalOrig ?? current;
    const wrapper = function (this: History, ...args: Parameters<History["pushState"]>): void {
      dispatchPre();
      previous.apply(this, args);
      dispatchPost();
    } as NavPatchedFn<History["pushState"]>;
    wrapper.__appsignalOrig = previous;
    history[method] = wrapper;
  }

  // Remove previous popstate handler before adding a new one (reinit safety)
  if (popstateHandler) window.removeEventListener("popstate", popstateHandler);
  popstateHandler = () => { dispatchPre(); dispatchPost(); };
  window.addEventListener("popstate", popstateHandler);
}

export function initBreadcrumbs(
  resolved: ResolvedConfig["breadcrumbs"],
  internalEndpointsForFilter: string[],
  privacyQueryParamsAllowlist: string[] = [],
  privacyNetworkBlocklist: string[] = [],
  privacyDom: ResolvedConfig["privacy"]["dom"] = { maskText: [], blockElement: [] },
  beforeBreadcrumb?: (breadcrumb: Breadcrumb) => Breadcrumb | null,
  onConsoleErrorFn?: (error: Error) => void,
): void {
  destroyBreadcrumbs();

  config = resolved;
  beforeBreadcrumbHook = beforeBreadcrumb;
  onConsoleError = onConsoleErrorFn;
  queryParamsAllowlist = privacyQueryParamsAllowlist;
  networkBlocklist = privacyNetworkBlocklist;
  setPrivacyDom(privacyDom);
  internalEndpoints = internalEndpointsForFilter;
  sessionBuffer = new RingBuffer<Breadcrumb>(SESSION_BUFFER_CAPACITY);
  errorBuffer = new RingBuffer<Breadcrumb>(ERROR_BUFFER_CAPACITY);

  // Register all collectors unconditionally — each handler reads the
  // module-level `config` and short-circuits when its category is off.
  initClicks();
  initNavigation();
  if (document.readyState === "complete") {
    recordDocumentLoad();
  } else {
    window.addEventListener("load", () => recordDocumentLoad(), { once: true });
  }
  initResourceTimingObserver();
  cleanups.push(
    onAfterRequest((result) => {
      if (!config.network) return;
      if (isCollectEndpoint(result.url) || isBlocklisted(result.url)) return;
      // Fire-and-forget — recordNetworkBreadcrumb awaits any deferred work
      // (body capture) before pushing, so the breadcrumb is complete on
      // push. The user's fetch promise has already resolved by the time
      // the after-request listener fires.
      void recordNetworkBreadcrumb(result);
    }),
  );
  initConsole();
  initLongTasks();
  initScrollDepth();
  initVisibility();
  initTabLifecycle();
}

export function addBreadcrumb(breadcrumb: Breadcrumb): void {
  const result = applyBeforeBreadcrumb(breadcrumb);
  if (!result) return;
  sessionBuffer.push(result);
  if (ERROR_BUFFER_CATEGORIES.has(result.category)) {
    errorBuffer.push(result);
  }
}

// beforeBreadcrumb decides whether the breadcrumb enters either buffer.
// A null return drops it from every downstream payload (error and periodic
// events flush alike). A thrown callback shouldn't break the SDK — treat
// it as passthrough rather than drop, so a bug in user code doesn't
// silently swallow breadcrumbs.
function applyBeforeBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  // Hot path: every network request, click, console call. Skip the hook
  // entirely when none is configured, rather than running it as identity.
  if (!beforeBreadcrumbHook) return breadcrumb;
  try {
    return beforeBreadcrumbHook(breadcrumb);
  } catch {
    return breadcrumb;
  }
}

export function addManualBreadcrumb(input: {
  category: string;
  message: string;
  data?: Record<string, unknown>;
}): void {
  // Host-supplied breadcrumbs bypass the error-buffer allowlist — the host
  // called addBreadcrumb() intentionally for debugging, so the breadcrumb
  // belongs in error context regardless of its category name.
  const result = applyBeforeBreadcrumb({
    timestamp: Date.now(),
    category: input.category,
    message: input.message,
    data: input.data,
  });
  if (!result) return;
  sessionBuffer.push(result);
  errorBuffer.push(result);
}

/** Snapshot of the *session* buffer — every breadcrumb that's been pushed
 * and not yet drained, including UX-derived categories. This is what tests
 * inspect and what would feed any future "session journey" view. */
export function getSnapshot(): Breadcrumb[] {
  return sessionBuffer.snapshot();
}

/** Snapshot of the error-context buffer — the last 25 debug-relevant
 * breadcrumbs. Pre-filtered at push time; consumers (errors.ts) don't
 * need to slice or strip categories. */
export function getErrorBreadcrumbs(): Breadcrumb[] {
  return errorBuffer.snapshot();
}

export function drainBreadcrumbs(): Breadcrumb[] {
  // Drain only the session buffer — the error buffer keeps its contents
  // across flushes so a later error still sees context from before the
  // most recent events flush.
  return sessionBuffer.drain();
}

export function clearBreadcrumbs(): void {
  sessionBuffer.clear();
  errorBuffer.clear();
}

// --- Click tracking ---

const RAGE_CLICK_THRESHOLD = 3;
const RAGE_CLICK_WINDOW_MS = 1000;
const RAGE_CLICK_MAX_DISTANCE_PX = 100;

interface ClickRecord {
  x: number;
  y: number;
  time: number;
}

let recentClicks: ClickRecord[] = [];

function clickDistance(a: ClickRecord, b: ClickRecord): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function initClicks(): void {
  const handler = (e: MouseEvent) => {
      if (!config.clicks) return;
      const target = e.target as Element;
      // Suppress the entire click pipeline (click + rage/dead/error) when the
      // target descends from a blocked element. This is the strongest privacy
      // guarantee: no breadcrumb at all, not even a masked one.
      if (blockElementSelector && target.closest(blockElementSelector)) return;
      const now = Date.now();
      const selector = elementSelector(target);

      // Round to integer CSS pixels — fractional values (Hi-DPI / touch) add
      // bytes on the wire without changing where the dot lands in replay.
      const x = Math.round(e.clientX);
      const y = Math.round(e.clientY);
      addBreadcrumb({
        timestamp: now,
        category: "click",
        message: selector,
        data: { x, y },
      });

      // Rage click detection: 3+ clicks within 1s, within 100px proximity,
      // on any element. Rapid repeated clicking is a frustration signal
      // regardless of whether the app responds — if a user is smashing a
      // button that *does* work they're still frustrated. Emit the
      // breadcrumb immediately rather than deferring to scheduleClickDetection
      // (which is the right model for dead_click, where the "no DOM mutation"
      // condition is the whole definition).
      const click: ClickRecord = { x, y, time: now };
      recentClicks.push(click);
      recentClicks = recentClicks.filter((c) => now - c.time < RAGE_CLICK_WINDOW_MS);

      const nearby = recentClicks.filter((c) => clickDistance(c, click) <= RAGE_CLICK_MAX_DISTANCE_PX);
      if (nearby.length >= RAGE_CLICK_THRESHOLD) {
        addBreadcrumb({
          timestamp: now,
          category: "rage_click",
          message: selector,
          data: { x, y },
        });
        recentClicks = [];
      }

      // Dead click detection: only on interactable elements. A single click on
      // a non-interactive element is often intentional (selecting text, closing
      // a dropdown by clicking outside).
      if (isInteractable(e.target as Element)) {
        scheduleClickDetection({
          selector,
          clickTime: now,
          category: "dead_click",
          windowMs: 300,
          x,
          y,
        });
      }

      // Error click detection: click followed by a JS error within 1 second
      detectErrorClick(selector, now, x, y);
  };
  document.addEventListener("click", handler, { capture: true, passive: true });
  cleanups.push(() => document.removeEventListener("click", handler, { capture: true }));
}

const INTERACTABLE_TAGS = new Set([
  "A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY", "OPTION",
]);

function isInteractable(el: Element): boolean {
  // Walk up the tree — a span inside a button is still interactable
  let node: Element | null = el;
  while (node) {
    if (INTERACTABLE_TAGS.has(node.tagName)) return true;
    if (node.getAttribute("role") === "button" || node.getAttribute("role") === "link") return true;
    if (node.hasAttribute("onclick") || node.hasAttribute("tabindex")) return true;
    if (node.tagName === "LABEL" && node.hasAttribute("for")) return true;
    node = node.parentElement;
  }
  return false;
}

// Monotonic timestamp of the last observed effect (DOM mutation, navigation,
// or fetch/xhr completion). Each click detection records its own
// detectionStartTime and checks `lastEffectTime > detectionStartTime` when
// its window closes. This isolates overlapping detections while keeping the
// one-observer efficiency — a boolean sentinel would erase earlier
// detections' effect information when a later click starts.
let lastEffectTime = 0;
let effectObserverActive = false;
let effectMutationObserver: MutationObserver | null = null;
let pendingDetections = 0;

function startEffectObservers(): void {
  if (effectObserverActive) return;
  effectObserverActive = true;

  effectMutationObserver = new MutationObserver(() => { lastEffectTime = Date.now(); });
  effectMutationObserver.observe(document.body, { childList: true, subtree: true });
}

function stopEffectObservers(): void {
  if (!effectObserverActive) return;
  effectObserverActive = false;
  if (effectMutationObserver) {
    effectMutationObserver.disconnect();
    effectMutationObserver = null;
  }
}

// Navigation also counts as an effect
onAfterNavigation(() => { lastEffectTime = Date.now(); });

// Narrowed to "dead_click" only. Rage is emitted immediately in initClicks —
// routing it through here would silence it whenever a click causes any DOM
// mutation (including the breadcrumb insertion itself).
function scheduleClickDetection({
  selector,
  clickTime,
  category,
  windowMs,
  x,
  y,
}: {
  selector: string;
  clickTime: number;
  category: "dead_click";
  windowMs: number;
  x: number;
  y: number;
}): void {
  const detectionStartTime = Date.now();
  pendingDetections++;
  startEffectObservers();

  setTimeout(() => {
    const hadEffect = lastEffectTime > detectionStartTime;
    pendingDetections--;
    if (pendingDetections === 0) {
      stopEffectObservers();
    }
    if (!hadEffect) {
      addBreadcrumb({
        timestamp: clickTime,
        category,
        message: selector,
        data: { x, y },
      });
    }
  }, windowMs);
}

function detectErrorClick(selector: string, clickTime: number, x: number, y: number): void {
  const errorBefore = getLastErrorTimestamp();
  setTimeout(() => {
    const errorAfter = getLastErrorTimestamp();
    if (errorAfter > errorBefore && errorAfter - clickTime < 1000) {
      addBreadcrumb({
        timestamp: clickTime,
        category: "error_click",
        message: selector,
        data: { x, y },
      });
    }
  }, 1000);
}

function elementSelector(el: Element | null): string {
  if (!el) return "unknown";

  // 1. Explicit override via data-breadcrumb (check element and ancestors)
  const breadcrumbLabel = findAttribute(el, "data-breadcrumb");
  if (breadcrumbLabel) return breadcrumbLabel;

  // 2. Try to find meaningful text — walk up if the element has none
  const text = findMeaningfulText(el);

  // 3. Semantic detection — what is this element?
  const semantic = detectSemantic(el);

  if (semantic && text) return `${semantic} "${text}"`;
  if (semantic) return semantic;
  if (text) return `${basicSelector(el)} "${text}"`;
  return basicSelector(el);
}

function basicSelector(el: Element): string {
  let s = el.tagName.toLowerCase();
  if (el.id) s += `#${el.id}`;
  return s;
}

function findMeaningfulText(el: Element): string {
  // Mask wins over text extraction: if the click target descends from a
  // masked element, never read its (or its ancestors') text. The breadcrumb
  // still fires, but no PII text rides along — only the structural selector.
  if (maskTextSelector && el.closest(maskTextSelector)) return "[masked]";

  // Try the element itself first (direct text, not deep children)
  const directText = getDirectText(el);
  if (directText) return directText;

  // Walk up to find nearest ancestor with text (max 5 levels)
  let current = el.parentElement;
  for (let i = 0; i < 5 && current; i++) {
    // Stop at large containers
    if (current.tagName === "BODY" || current.tagName === "MAIN" || current.tagName === "SECTION") break;

    // Check for aria-label on the way up
    const ariaLabel = current.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim().slice(0, 50);

    // Check for meaningful text on interactive ancestors
    const tag = current.tagName.toLowerCase();
    if (tag === "a" || tag === "button" || current.getAttribute("role") === "button") {
      const text = getDirectText(current);
      if (text) return text;
    }

    current = current.parentElement;
  }

  return "";
}

function getDirectText(el: Element): string {
  // Get text that belongs to this element, not deeply nested children
  // For small elements, textContent is fine
  const text = (el.textContent || "").trim();
  if (text.length > 0) return text.slice(0, 50);

  // Check common attributes
  const title = el.getAttribute("title");
  if (title) return title.trim().slice(0, 50);

  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel.trim().slice(0, 50);

  const alt = (el as HTMLImageElement).alt;
  if (alt) return alt.trim().slice(0, 50);

  const placeholder = (el as HTMLInputElement).placeholder;
  if (placeholder) return placeholder.trim().slice(0, 50);

  return "";
}

function detectSemantic(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute("role");
  const type = (el as HTMLInputElement).type;

  // ARIA roles
  if (role === "button") return "button";
  if (role === "link") return "link";
  if (role === "tab") return "tab";
  if (role === "menuitem") return "menu item";
  if (role === "checkbox") return "checkbox";
  if (role === "radio") return "radio";
  if (role === "switch") return "switch";
  if (role === "option") return "option";
  if (role === "navigation") return "navigation";

  // HTML elements
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "input" && type === "submit") return "submit button";
  if (tag === "input" && type === "checkbox") return "checkbox";
  if (tag === "input" && type === "radio") return "radio";
  if (tag === "input") return "input";
  if (tag === "select") return "dropdown";
  if (tag === "textarea") return "text area";
  if (tag === "details" || tag === "summary") return "expandable";
  if (tag === "nav") return "navigation";
  if (tag === "th") return "table header";
  if (tag === "td") return "table cell";
  if (tag === "li") return "list item";
  if (tag === "label") return "label";
  if (tag === "img") return "image";
  if (tag === "video") return "video";

  // SVG elements
  if (tag === "svg" || tag === "path" || tag === "circle" || tag === "rect" || tag === "g") {
    return "icon";
  }

  return "";
}

function findAttribute(el: Element, attr: string): string {
  let current: Element | null = el;
  for (let i = 0; i < 5 && current; i++) {
    const val = current.getAttribute(attr);
    if (val) return val;
    current = current.parentElement;
  }
  return "";
}

// --- Document load ---

function recordDocumentLoad(): void {
  try {
    const entries = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[]
    if (entries.length === 0) return
    const nav = entries[0]

    const duration = Math.round(nav.responseEnd - nav.startTime)
    const data: Record<string, unknown> = {
      initiator: "document",
      method: "GET",
      url: nav.name,
      status: nav.responseStatus || 200,
      duration,
    }

    const rt = timingPhases(nav)
    if (Object.keys(rt).length > 0) data.resource_timing = rt

    // Use the navigation start time so it sorts before other breadcrumbs
    addBreadcrumb({
      timestamp: Math.round(nav.startTime + timeOrigin()),
      category: "network",
      message: `GET ${nav.name}`,
      data,
    })
  } catch {
    // Navigation Timing API not available
  }
}

// --- Navigation tracking ---

function initNavigation(): void {
  // Compare against the raw href (we need to detect any URL change, including
  // params that the allowlist would strip). The breadcrumb captures the
  // scrubbed form so the dashboard never sees sensitive params.
  let lastUrl = location.href;
  const scrubbedInitial = scrubUrl(lastUrl, queryParamsAllowlist);

  addBreadcrumb({
    timestamp: Date.now(),
    category: "navigation",
    message: scrubbedInitial,
    data: { to: scrubbedInitial },
  });

  const recordNav = () => {
    const newUrl = location.href;
    if (newUrl !== lastUrl) {
      const from = scrubUrl(lastUrl, queryParamsAllowlist);
      const to = scrubUrl(newUrl, queryParamsAllowlist);
      addBreadcrumb({
        timestamp: Date.now(),
        category: "navigation",
        message: `${from} → ${to}`,
        data: { from, to },
      });
      lastUrl = newUrl;
      touchActivity();
    }
  };

  onAfterNavigation(recordNav);
  window.addEventListener("hashchange", recordNav);
  cleanups.push(() => window.removeEventListener("hashchange", recordNav));
}

// --- Resource timing ---

// Recent resource-timing entries awaiting correlation with a network
// breadcrumb. A list (not a URL-keyed map) because several requests can share a
// URL — common for POST APIs — and a map would let concurrent entries overwrite
// each other, leaving all but one breadcrumb without timing.
let resourceTimings: { entry: PerformanceResourceTiming; addedAt: number }[] = [];
const TIMING_MAX_AGE_MS = 30_000;
// Age alone doesn't bound this list: entries are only consumed by a matching
// network breadcrumb, and plenty never get one — ingest/blocklisted URLs are
// filtered out before recordNetworkBreadcrumb, and with `network: false` the
// observer still runs (click-effect detection needs it) while nothing reads it.
// A busy polling app would otherwise hold 30s of requests, so cap the list and
// drop oldest-first.
const TIMING_MAX_ENTRIES = 200;

function initResourceTimingObserver(): void {
  if (typeof PerformanceObserver === "undefined") return;

  try {
    const observer = new PerformanceObserver((list) => {
      const now = Date.now();
      for (const entry of list.getEntries()) {
        const rt = entry as PerformanceResourceTiming;
        // Only fetch/xhr entries are ever looked up (from network breadcrumbs),
        // so skip storing images/scripts/etc.
        if (rt.initiatorType === "xmlhttprequest" || rt.initiatorType === "fetch") {
          // Mark as effect for click detection (fetch/xhr activity after click)
          lastEffectTime = now;
          resourceTimings.push({ entry: rt, addedAt: now });
        }
      }
      // Drop what aged out, then the oldest overflow — newest entries win both.
      resourceTimings = resourceTimings
        .filter((t) => now - t.addedAt <= TIMING_MAX_AGE_MS)
        .slice(-TIMING_MAX_ENTRIES);
    });
    // `buffered: true` replays entries recorded before the observer registered,
    // covering the gap between initNetworkHook (which starts producing network
    // breadcrumbs) and this observer. Requests that finished before the hook was
    // installed have no breadcrumb to attach to, so those replayed entries go
    // unclaimed and age out — the cap above keeps that bounded. Requires the
    // single-`type` form of observe().
    observer.observe({ type: "resource", buffered: true });
    cleanups.push(() => observer.disconnect());
  } catch {
    // resource timing not supported
  }
}

// Find the resource-timing entry that best matches a request to `url` in the
// [requestStart, requestEnd] epoch-ms window and consume it. Correlating by URL
// alone is ambiguous when several requests hit the same endpoint, so the entry
// whose start is closest to the request start wins and is removed, so a
// concurrent same-URL request can't claim it too.
function getResourceTiming(
  url: string,
  requestStart: number,
  requestEnd: number,
): Record<string, unknown> | undefined {
  if (resourceTimings.length === 0) return undefined;

  // PerformanceResourceTiming times are relative to timeOrigin; lift them to
  // epoch ms to compare against the request's Date.now()-based window. One
  // origin for the whole scan so candidates are compared on the same basis.
  const origin = timeOrigin();
  // Only parsed if some entry fails to match `url` verbatim — callers coming
  // from fetch/Request already hand us an absolute URL.
  let resolved: string | undefined;

  let best: { entry: PerformanceResourceTiming; addedAt: number } | undefined;
  let bestDistance = Infinity;
  for (const candidate of resourceTimings) {
    const { entry } = candidate;
    if (entry.name !== url) {
      resolved ??= new URL(url, location.origin).href;
      if (entry.name !== resolved) continue;
    }
    const entryStart = origin + entry.startTime;
    // Skip entries clearly outside the request window (1s slack for clock skew)
    // so a stale same-URL entry isn't matched to an unrelated request.
    if (origin + entry.responseEnd < requestStart - 1000) continue;
    if (entryStart > requestEnd + 1000) continue;
    const distance = Math.abs(entryStart - requestStart);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  if (!best) return undefined;

  resourceTimings.splice(resourceTimings.indexOf(best), 1);

  // Cross-origin responses without a Timing-Allow-Origin header have their
  // detailed timing zeroed for privacy. `responseStart === 0` signals that; skip
  // rather than emit all-zero phases that would misleadingly read as "0ms".
  if (best.entry.responseStart === 0) return undefined;

  const timing = timingPhases(best.entry);
  return Object.keys(timing).length > 0 ? timing : undefined;
}

// Phase/size breakdown shared by fetch/xhr resource entries and the
// document-load navigation entry (PerformanceNavigationTiming extends
// PerformanceResourceTiming), so both breadcrumb kinds emit one wire shape.
// Zero-valued phases are omitted: a reused connection reports 0 for dns/connect,
// and a consumer can't tell that apart from "not measured" anyway.
function timingPhases(entry: PerformanceResourceTiming): Record<string, unknown> {
  const timing: Record<string, unknown> = {};

  const dns = entry.domainLookupEnd - entry.domainLookupStart;
  const connect = entry.connectEnd - entry.connectStart;
  const ssl = entry.secureConnectionStart > 0
    ? entry.connectEnd - entry.secureConnectionStart
    : 0;
  const ttfb = entry.responseStart - entry.requestStart;
  const download = entry.responseEnd - entry.responseStart;

  if (dns > 0) timing.dns = Math.round(dns);
  if (connect > 0) timing.connect = Math.round(connect);
  if (ssl > 0) timing.ssl = Math.round(ssl);
  if (ttfb > 0) timing.ttfb = Math.round(ttfb);
  if (download > 0) timing.download = Math.round(download);
  if (entry.transferSize > 0) timing.transfer_size = entry.transferSize;
  if (entry.encodedBodySize > 0) timing.encoded_body_size = entry.encodedBodySize;
  if (entry.decodedBodySize > 0) timing.decoded_body_size = entry.decodedBodySize;
  if (entry.nextHopProtocol) timing.protocol = entry.nextHopProtocol;

  return timing;
}

// --- Network tracking ---

function isBlocklisted(url: string): boolean {
  const parsed = safeUrl(url);
  if (!parsed) return false;
  const hostPath = parsed.host + parsed.pathname;
  return networkBlocklist.some((pattern) => globMatch(pattern, hostPath));
}

function isCollectEndpoint(url: string): boolean {
  return internalEndpoints.some((e) => url.includes(e));
}

async function recordNetworkBreadcrumb(result: RequestResult): Promise<void> {
  const initiator = result.xhr ? "xhr" : "fetch";
  const filteredUrl = scrubUrl(result.url, queryParamsAllowlist);

  if (result.error) {
    // Transport failure — no response received.
    addBreadcrumb({
      timestamp: result.startTime,
      category: "network",
      message: `${result.method} ${filteredUrl} (error)`,
      data: { initiator, method: result.method, url: filteredUrl, error: true },
    });
    return;
  }

  const data: Record<string, unknown> = {
    initiator,
    method: result.method,
    url: filteredUrl,
    status: result.status,
    duration: result.endTime - result.startTime,
  };

  const traceId = consumeTraceId(result.url);
  if (traceId) data.trace_id = traceId;

  // Resource timing — the PerformanceObserver may not have flushed yet, so
  // a sync read often returns nothing right after fetch resolution. Wait
  // briefly and re-read before pushing, so the breadcrumb is complete on
  // push (same pattern as body capture above). Without this, a flush
  // between fetch resolution and the timing entry's arrival serialises
  // without resource_timing — the case that matters most is a fetch right
  // before a pagehide, which is exactly when timing detail is wanted.
  let rt = getResourceTiming(result.url, result.startTime, result.endTime);
  if (!rt) {
    await new Promise((r) => setTimeout(r, 150));
    rt = getResourceTiming(result.url, result.startTime, result.endTime);
  }
  if (rt) data.resource_timing = rt;

  addBreadcrumb({
    timestamp: result.startTime,
    category: "network",
    message: `${result.method} ${filteredUrl} ${result.status}`,
    data,
  });

  touchActivity();
}

// --- Console tracking ---

function initConsole(): void {
  origConsoleWarn = console.warn.bind(console);
  origConsoleError = console.error.bind(console);

  console.warn = function (...args: unknown[]) {
    if (config.console) {
      // Never let breadcrumb capture throw out of the patched console method:
      // it would propagate into host code *and* skip the real console call
      // below. formatConsoleArgs already serialises defensively; this is
      // belt-and-braces for any other surprise (e.g. a hostile toJSON).
      try {
        addBreadcrumb({
          timestamp: Date.now(),
          category: "console",
          message: formatConsoleArgs(args).slice(0, 200),
          data: { level: "warn" },
        });
      } catch { /* swallow — the host's console call must still run */ }
    }
    origConsoleWarn(...args);
  };

  console.error = function (...args: unknown[]) {
    // Serialise the args once — shared by the breadcrumb and the synthesized
    // console error, both of which otherwise JSON-stringify the same args.
    const formatted = config.console || onConsoleError ? formatConsoleArgs(args) : "";
    if (config.console) {
      try {
        addBreadcrumb({
          timestamp: Date.now(),
          category: "console",
          message: formatted.slice(0, 200),
          data: { level: "error" },
        });
      } catch { /* swallow — the host's console call must still run */ }
    }
    // Escalate to a reported error when errors.console is enabled. Guarded and
    // swallowed for the same reason as the breadcrumb above: the host's console
    // call below must always run, even if reporting throws.
    if (onConsoleError) {
      try { onConsoleError(consoleArgsToError(args, formatted)); } catch { /* swallow */ }
    }
    origConsoleError(...args);
  };

  cleanups.push(() => {
    console.warn = origConsoleWarn;
    console.error = origConsoleError;
  });
}

function formatConsoleArgs(args: unknown[]): string {
  return args.map(safeStringifyArg).join(" ");
}

// Cap the synthesized console-error message. The breadcrumb is truncated to
// 200; without a cap here a `console.error("state", hugeObject)` would ship a
// multi-KB message and use it verbatim as the dedupe key. A passed Error keeps
// its own (untouched) message.
const CONSOLE_MESSAGE_MAX = 2000;

// Build the Error to report from console.error's arguments. If the caller
// passed an Error (`console.error(err)` / `console.error("ctx", err)`), reuse
// it so its real stack survives; otherwise synthesize one from the
// already-formatted args. errors.reportConsoleError strips the SDK frames off
// the synthesized stack so it roots at the caller.
function consoleArgsToError(args: unknown[], formatted: string): Error {
  const existing = args.find((a): a is Error => a instanceof Error);
  if (existing) return existing;
  const err = new Error(formatted.slice(0, CONSOLE_MESSAGE_MAX));
  err.name = "console.error";
  return err;
}

// JSON.stringify throws on circular structures (DOM nodes, React elements,
// any object with a back-reference) and on BigInt — all common console
// arguments. A throw here would escape the patched console method into host
// code, so fall back to String() rather than propagate. JSON.stringify also
// returns undefined for functions/undefined; coerce those too.
function safeStringifyArg(a: unknown): string {
  if (typeof a === "string") return a;
  // Errors carry message/stack on non-enumerable properties, so
  // JSON.stringify(err) === "{}" — surface the actual message instead. Covers
  // console.error(err), the most common way a console breadcrumb loses its text.
  const asError = errorLike(a);
  if (asError) return `${asError.name}: ${asError.message}`;
  try {
    return JSON.stringify(a) ?? String(a);
  } catch {
    return String(a);
  }
}

// --- Long task tracking ---

function initLongTasks(): void {
  if (typeof PerformanceObserver === "undefined") return;

  // Try Long Animation Frame API first (Chrome 123+) — has script attribution
  try {
    const observer = new PerformanceObserver((list) => {
      if (!config.longTasks) return;
      for (const entry of list.getEntries()) {
        if (entry.duration > 50) {
          // LoAF entries have a .scripts array (not in TS lib types yet)
          const raw = entry as unknown as Record<string, unknown>;
          const scripts = Array.isArray(raw.scripts) ? raw.scripts : [];
          const top = scripts[0] as Record<string, unknown> | undefined;

          const sourceURL = typeof top?.sourceURL === "string" ? top.sourceURL : "";
          const sourceFn = typeof top?.sourceFunctionName === "string" ? top.sourceFunctionName : "";
          const invoker = typeof top?.invoker === "string" ? top.invoker : "";

          const attribution = sourceURL
            ? `${sourceFn || "anonymous"} (${sourceURL.split("/").pop()})`
            : undefined;

          const data: Record<string, unknown> = {
            duration: Math.round(entry.duration),
          };
          if (invoker) data.invoker = invoker;
          if (sourceURL) data.source_url = sourceURL;
          if (sourceFn) data.source_function = sourceFn;

          addBreadcrumb({
            timestamp: Date.now(),
            category: "long_task",
            message: attribution
              ? `Main thread blocked for ${Math.round(entry.duration)}ms by ${attribution}`
              : `Main thread blocked for ${Math.round(entry.duration)}ms`,
            data,
          });
        }
      }
    });
    observer.observe({ type: "long-animation-frame", buffered: true });
    cleanups.push(() => observer.disconnect());
    return;
  } catch {
    // long-animation-frame not supported — fall through to longtask
  }

  // Fallback: basic longtask observer (no attribution)
  try {
    const observer = new PerformanceObserver((list) => {
      if (!config.longTasks) return;
      for (const entry of list.getEntries()) {
        if (entry.duration > 50) {
          addBreadcrumb({
            timestamp: Date.now(),
            category: "long_task",
            message: `Main thread blocked for ${Math.round(entry.duration)}ms`,
            data: { duration: Math.round(entry.duration) },
          });
        }
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
    cleanups.push(() => observer.disconnect());
  } catch {
    // longtask not supported — silently skip
  }
}

// --- Scroll depth tracking ---

let maxScrollPercent = 0;
let lastScrollUrl = "";

function getScrollPercent(target?: EventTarget | null): number {
  // If the scroll happened on a specific element (SPA content container),
  // measure that element's scroll position instead of the viewport.
  if (target && target instanceof HTMLElement && target !== document.documentElement && target !== document.body) {
    const totalHeight = target.scrollHeight;
    const visibleHeight = target.clientHeight;
    if (totalHeight <= visibleHeight) return 100;
    return Math.min(100, Math.round(((target.scrollTop + visibleHeight) / totalHeight) * 100));
  }
  // Fallback: viewport scroll
  const docHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body.scrollHeight,
  );
  const viewportHeight = window.innerHeight;
  if (docHeight <= viewportHeight) return 100;
  const scrollTop = window.scrollY || document.documentElement.scrollTop;
  return Math.min(100, Math.round(((scrollTop + viewportHeight) / docHeight) * 100));
}

function flushScrollDepth(): void {
  if (config.scrollDepth && maxScrollPercent > 0 && lastScrollUrl) {
    addBreadcrumb({
      timestamp: Date.now(),
      category: "scroll_depth",
      message: `${maxScrollPercent}% of ${lastScrollUrl}`,
      data: { percent: maxScrollPercent, url: lastScrollUrl },
    });
  }
  maxScrollPercent = 0;
  lastScrollUrl = location.href;
}

function initScrollDepth(): void {
  lastScrollUrl = location.href;

  // Use capture phase on document because scroll events don't bubble.
  // SPAs typically scroll inside a container div (overflow-y: auto), not the
  // viewport. Capture catches scroll on any element, then we measure the
  // viewport scroll position which reflects the page-level reading depth.
  let throttleTimer: ReturnType<typeof setTimeout> | null = null;
  let lastScrollTarget: EventTarget | null = null;
  const scrollHandler = (e: Event) => {
    if (!config.scrollDepth) return;
    lastScrollTarget = e.target;
    if (throttleTimer) return;
    throttleTimer = setTimeout(() => {
      throttleTimer = null;
      const pct = getScrollPercent(lastScrollTarget);
      if (pct > maxScrollPercent) maxScrollPercent = pct;
    }, 200);
  };
  document.addEventListener("scroll", scrollHandler, { capture: true, passive: true });

  onBeforeNavigation(flushScrollDepth);

  const offVis = onVisibilityChange((state) => {
    if (state === "hidden") flushScrollDepth();
  });

  cleanups.push(
    () => document.removeEventListener("scroll", scrollHandler, { capture: true }),
    offVis,
  );
}

// --- Visibility tracking ---

function initVisibility(): void {
  const off = onVisibilityChange((state) => {
    addBreadcrumb({
      timestamp: Date.now(),
      category: "visibility",
      message: `Tab became ${state}`,
      data: { state },
    });
  });
  cleanups.push(off);
}

// --- Tab lifecycle tracking ---

function initTabLifecycle(): void {
  addBreadcrumb({
    timestamp: Date.now(),
    category: "tab",
    message: "Tab opened",
    data: { event: "open" },
  });

  // pagehide is the cross-browser tab-close signal; beforeunload is unreliable on mobile.
  // We don't branch on persisted — bfcache resumes will emit fresh breadcrumbs on the same tab_id.
  const off = onPageHide(() => {
    addBreadcrumb({
      timestamp: Date.now(),
      category: "tab",
      message: "Tab closed",
      data: { event: "close" },
    });
  });
  cleanups.push(off);
}

// --- Destroy ---

export function destroyBreadcrumbs(): void {
  for (const fn of cleanups) fn();
  cleanups = [];
  // Restore the handler we captured (may be a foreign wrapper), not native — and
  // only if our wrapper is still on top, else we'd clobber whatever patched over us.
  if (navigationHookInstalled) {
    for (const method of NAV_METHODS) {
      const current = history[method] as NavPatchedFn<History["pushState"]>;
      if (current.__appsignalOrig) history[method] = current.__appsignalOrig;
    }
    if (popstateHandler) {
      window.removeEventListener("popstate", popstateHandler);
      popstateHandler = null;
    }
    navigationHookInstalled = false;
  }
  preNavListeners = [];
  postNavListeners = [];
  resourceTimings = [];
  recentClicks = [];
  sessionBuffer = new RingBuffer<Breadcrumb>(SESSION_BUFFER_CAPACITY);
  errorBuffer = new RingBuffer<Breadcrumb>(ERROR_BUFFER_CAPACITY);
  beforeBreadcrumbHook = undefined;
}
