import type { Breadcrumb, ServerConfig } from "./types.js";
import { RingBuffer } from "./ring-buffer.js";
import { touchActivity } from "./session.js";
import { getLastErrorTimestamp } from "./errors.js";
import { consumeTraceId } from "./tracing.js";
import { safeUrl, globMatch, filterQueryParams } from "./utils.js";
import { getConsent } from "./consent.js";

let buffer: RingBuffer<Breadcrumb> = new RingBuffer<Breadcrumb>(100);
let config: ServerConfig["breadcrumbs"];
let collectEndpoint = "";

// Original references for patching
let origFetch: typeof fetch;
let origXhrOpen: typeof XMLHttpRequest.prototype.open;
let origXhrSend: typeof XMLHttpRequest.prototype.send;
let origConsoleWarn: typeof console.warn;
let origConsoleError: typeof console.error;

// Cleanup functions for all observers, listeners, and patches
let cleanups: (() => void)[] = [];

// ── Central navigation hook ──────────────────────────────────────────────
// Single set of pushState/replaceState/popstate patches. Features register
// callbacks instead of each patching history methods independently.
//
// The true originals are captured once, before any patching. On reinit
// (tests, HMR) we re-patch from the originals instead of wrapping the
// previous wrapper, so the call chain stays flat.

let preNavListeners: (() => void)[] = [];
let postNavListeners: (() => void)[] = [];
let navigationHookInstalled = false;
let popstateHandler: (() => void) | null = null;
const origPushState = history.pushState.bind(history);
const origReplaceState = history.replaceState.bind(history);

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
  const dispatchPre = () => { for (const fn of preNavListeners) fn(); };
  const dispatchPost = () => { for (const fn of postNavListeners) fn(); };
  history.pushState = function (...args) { dispatchPre(); origPushState(...args); dispatchPost(); };
  history.replaceState = function (...args) { dispatchPre(); origReplaceState(...args); dispatchPost(); };
  // Remove previous popstate handler before adding a new one (reinit safety)
  if (popstateHandler) window.removeEventListener("popstate", popstateHandler);
  popstateHandler = () => { dispatchPre(); dispatchPost(); };
  window.addEventListener("popstate", popstateHandler);
}

export function initBreadcrumbs(
  serverConfig: ServerConfig["breadcrumbs"],
  endpoint: string,
): void {
  destroyBreadcrumbs();

  config = serverConfig;
  collectEndpoint = endpoint;
  buffer = new RingBuffer<Breadcrumb>(config.capacity);

  if (config.clicks) initClicks();
  initNavigation();
  if (document.readyState === "complete") {
    recordDocumentLoad();
  } else {
    window.addEventListener("load", () => recordDocumentLoad(), { once: true });
  }
  if (config.network) {
    initResourceTimingObserver();
    initNetwork();
  }
  if (config.console) initConsole();
  if (config.long_tasks) initLongTasks();
  if (config.scroll_depth) initScrollDepth();
  if (config.form_abandonment) initFormAbandonment();
  if (config.user_timing) initUserTiming();
  initVisibility();
  initTabLifecycle();
}

export function addBreadcrumb(crumb: Breadcrumb): void {
  if (getConsent() === "not-granted") return;
  buffer.push(crumb);
}

export function addManualBreadcrumb(input: {
  category: string;
  message: string;
  data?: Record<string, unknown>;
}): void {
  addBreadcrumb({
    timestamp: Date.now(),
    category: input.category,
    message: input.message,
    data: input.data,
  });
}

export function getSnapshot(): Breadcrumb[] {
  return buffer.snapshot();
}

export function drainBreadcrumbs(): Breadcrumb[] {
  return buffer.drain();
}

export function updateBreadcrumbConfig(serverConfig: ServerConfig["breadcrumbs"]): void {
  config = serverConfig;
}

export function clearBreadcrumbs(): void {
  buffer.clear();
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
      const now = Date.now();
      const selector = elementSelector(e.target as Element);

      addBreadcrumb({
        timestamp: now,
        category: "click",
        message: selector,
      });

      // Rage click detection: 3+ clicks within 1s, within 100px proximity,
      // on any element. Rapid repeated clicking is a frustration signal
      // regardless of whether the app responds — if a user is smashing a
      // button that *does* work they're still frustrated. Emit the
      // breadcrumb immediately rather than deferring to scheduleClickDetection
      // (which is the right model for dead_click, where the "no DOM mutation"
      // condition is the whole definition).
      const click: ClickRecord = { x: e.clientX, y: e.clientY, time: now };
      recentClicks.push(click);
      recentClicks = recentClicks.filter((c) => now - c.time < RAGE_CLICK_WINDOW_MS);

      const nearby = recentClicks.filter((c) => clickDistance(c, click) <= RAGE_CLICK_MAX_DISTANCE_PX);
      if (nearby.length >= RAGE_CLICK_THRESHOLD) {
        addBreadcrumb({
          timestamp: now,
          category: "rage_click",
          message: selector,
        });
        recentClicks = [];
      }

      // Dead click detection: only on interactable elements. A single click on
      // a non-interactive element is often intentional (selecting text, closing
      // a dropdown by clicking outside).
      if (isInteractable(e.target as Element)) {
        scheduleClickDetection(selector, now, "dead_click", 300);
      }

      // Error click detection: click followed by a JS error within 1 second
      detectErrorClick(selector, now);
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
function scheduleClickDetection(
  selector: string,
  clickTime: number,
  category: "dead_click",
  windowMs: number,
): void {
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
      });
    }
  }, windowMs);
}

function detectErrorClick(selector: string, clickTime: number): void {
  const errorBefore = getLastErrorTimestamp();
  setTimeout(() => {
    const errorAfter = getLastErrorTimestamp();
    if (errorAfter > errorBefore && errorAfter - clickTime < 1000) {
      addBreadcrumb({
        timestamp: clickTime,
        category: "error_click",
        message: selector,
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

    // Timing breakdown — same fields as getResourceTiming() for fetch/xhr
    const rt: Record<string, unknown> = {}
    const dns = Math.round(nav.domainLookupEnd - nav.domainLookupStart)
    const connect = Math.round(nav.connectEnd - nav.connectStart)
    const ssl = nav.secureConnectionStart > 0 ? Math.round(nav.connectEnd - nav.secureConnectionStart) : 0
    const ttfb = Math.round(nav.responseStart - nav.requestStart)
    const download = Math.round(nav.responseEnd - nav.responseStart)
    if (dns > 0) rt.dns = dns
    if (connect > 0) rt.connect = connect
    if (ssl > 0) rt.ssl = ssl
    if (ttfb > 0) rt.ttfb = ttfb
    if (download > 0) rt.download = download
    if (nav.transferSize > 0) rt.transfer_size = nav.transferSize
    if (nav.encodedBodySize > 0) rt.encoded_body_size = nav.encodedBodySize
    if (nav.decodedBodySize > 0) rt.decoded_body_size = nav.decodedBodySize
    if (nav.nextHopProtocol) rt.protocol = nav.nextHopProtocol
    if (Object.keys(rt).length > 0) data.resource_timing = rt

    // Use the navigation start time so it sorts before other breadcrumbs
    addBreadcrumb({
      timestamp: Math.round(nav.startTime + performance.timeOrigin),
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
  let lastUrl = location.href;

  // Record the current page as the first navigation breadcrumb
  addBreadcrumb({
    timestamp: Date.now(),
    category: "navigation",
    message: lastUrl,
    data: { to: lastUrl },
  });

  const recordNav = () => {
    const newUrl = location.href;
    if (newUrl !== lastUrl) {
      addBreadcrumb({
        timestamp: Date.now(),
        category: "navigation",
        message: `${lastUrl} → ${newUrl}`,
        data: { from: lastUrl, to: newUrl },
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

// Store recent resource timing entries keyed by URL for lookup
const resourceTimings = new Map<string, { entry: PerformanceResourceTiming; addedAt: number }>();
const TIMING_MAX_AGE_MS = 30_000;

function initResourceTimingObserver(): void {
  if (typeof PerformanceObserver === "undefined") return;

  try {
    const observer = new PerformanceObserver((list) => {
      const now = Date.now();
      for (const entry of list.getEntries()) {
        const rt = entry as PerformanceResourceTiming;
        // Mark as effect for click detection (fetch/xhr activity after click)
        if (rt.initiatorType === "xmlhttprequest" || rt.initiatorType === "fetch") {
          lastEffectTime = Date.now();
        }
        resourceTimings.set(rt.name, { entry: rt, addedAt: now });
      }
      // Evict stale entries unconditionally
      for (const [key, val] of resourceTimings) {
        if (now - val.addedAt > TIMING_MAX_AGE_MS) resourceTimings.delete(key);
      }
    });
    observer.observe({ entryTypes: ["resource"] });
    cleanups.push(() => observer.disconnect());
  } catch {
    // resource timing not supported
  }
}

function getResourceTiming(url: string): Record<string, unknown> | undefined {
  // Try exact URL match first, then try resolved URL
  const wrapped = resourceTimings.get(url)
    ?? resourceTimings.get(new URL(url, location.origin).href);
  if (!wrapped) return undefined;
  const entry = wrapped.entry;

  // Clean up after use
  resourceTimings.delete(entry.name);

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

  return Object.keys(timing).length > 0 ? timing : undefined;
}

// --- Network tracking ---

function isBlocklisted(url: string): boolean {
  const parsed = safeUrl(url);
  if (!parsed) return false;
  const hostPath = parsed.host + parsed.pathname;
  return config.network_blocklist.some((pattern) =>
    globMatch(pattern, hostPath),
  );
}

function isCollectEndpoint(url: string): boolean {
  return url.includes(collectEndpoint);
}

function shouldCapturePayload(contentType: string | null): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  // Always skip binary types
  if (
    lower.includes("image/") ||
    lower.includes("video/") ||
    lower.includes("audio/") ||
    lower.includes("application/octet-stream")
  ) {
    return false;
  }
  return config.network_payloads.content_types.some((ct) =>
    lower.startsWith(ct),
  );
}

function truncateBody(
  body: string,
): { body: string; truncated: boolean } {
  if (body.length > config.network_payloads.max_size_bytes) {
    return {
      body: body.slice(0, config.network_payloads.max_size_bytes),
      truncated: true,
    };
  }
  return { body, truncated: false };
}

function initNetwork(): void {
  // Patch fetch
  origFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    if (isCollectEndpoint(url) || isBlocklisted(url)) {
      return origFetch(input, init);
    }

    const method = init?.method || "GET";
    const start = Date.now();
    let requestBody: string | undefined;

    // Capture request body if enabled
    if (
      config.network_payloads.enabled &&
      config.network_payloads.request_body &&
      init?.body &&
      typeof init.body === "string"
    ) {
      requestBody = init.body;
    }

    try {
      const response = await origFetch(input, init);
      const duration = Date.now() - start;
      const data: Record<string, unknown> = {
        initiator: "fetch",
        method,
        url: filterQueryParams(url, config.query_params_allowlist),
        status: response.status,
        duration,
      };

      // Attach trace ID if distributed tracing generated one for this request
      const traceId = consumeTraceId(url);
      if (traceId) data.trace_id = traceId;

      // Capture response body if enabled
      if (
        config.network_payloads.enabled &&
        config.network_payloads.response_body &&
        shouldCapturePayload(response.headers.get("content-type"))
      ) {
        try {
          const cloned = response.clone();
          const text = await cloned.text();
          const result = truncateBody(text);
          data.response_body = result.body;
          if (result.truncated) data.truncated = true;
        } catch {
          // Ignore body read failures
        }
      }

      if (requestBody && config.network_payloads.enabled) {
        const result = truncateBody(requestBody);
        data.request_body = result.body;
        if (result.truncated) data.request_truncated = true;
      }

      // Try synchronous lookup first, fall back to async (observer may not have fired yet)
      const rt = getResourceTiming(url);
      if (rt) {
        data.resource_timing = rt;
      } else {
        setTimeout(() => {
          const timing = getResourceTiming(url);
          if (timing) data.resource_timing = timing;
        }, 150);
      }

      addBreadcrumb({
        timestamp: start,
        category: "network",
        message: `${method} ${filterQueryParams(url, config.query_params_allowlist)} ${response.status}`,
        data,
      });
      touchActivity();
      return response;
    } catch (err) {
      addBreadcrumb({
        timestamp: start,
        category: "network",
        message: `${method} ${filterQueryParams(url, config.query_params_allowlist)} (error)`,
        data: { initiator: "fetch", method, url: filterQueryParams(url, config.query_params_allowlist), error: true },
      });
      throw err;
    }
  };

  // Patch XMLHttpRequest
  origXhrOpen = XMLHttpRequest.prototype.open;
  origXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    (this as XMLHttpRequest & { _asMethod: string; _asUrl: string })._asMethod =
      method;
    (this as XMLHttpRequest & { _asUrl: string })._asUrl =
      typeof url === "string" ? url : url.href;
    return origXhrOpen.call(this, method, url, ...(rest as [boolean, string?, string?]));
  };

  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const xhr = this as XMLHttpRequest & {
      _asMethod: string;
      _asUrl: string;
    };
    const url = xhr._asUrl;

    if (!url || isCollectEndpoint(url) || isBlocklisted(url)) {
      return origXhrSend.call(this, body);
    }

    const method = xhr._asMethod || "GET";
    const start = Date.now();

    // Capture request body if enabled
    let requestBody: string | undefined;
    if (
      config.network_payloads.enabled &&
      config.network_payloads.request_body &&
      body &&
      typeof body === "string"
    ) {
      requestBody = body;
    }

    xhr.addEventListener("load", () => {
      const duration = Date.now() - start;
      const data: Record<string, unknown> = {
        initiator: "xhr",
        method,
        url: filterQueryParams(url, config.query_params_allowlist),
        status: xhr.status,
        duration,
      };

      // Attach trace ID if distributed tracing generated one for this request
      const traceId = consumeTraceId(url);
      if (traceId) data.trace_id = traceId;

      if (
        config.network_payloads.enabled &&
        config.network_payloads.response_body &&
        shouldCapturePayload(xhr.getResponseHeader("content-type"))
      ) {
        try {
          const result = truncateBody(xhr.responseText);
          data.response_body = result.body;
          if (result.truncated) data.truncated = true;
        } catch {
          // Ignore
        }
      }

      if (requestBody && config.network_payloads.enabled) {
        const result = truncateBody(requestBody);
        data.request_body = result.body;
        if (result.truncated) data.request_truncated = true;
      }

      // Enrich with resource timing after a microtask
      setTimeout(() => {
        const timing = getResourceTiming(url);
        if (timing) data.resource_timing = timing;
      }, 0);

      addBreadcrumb({
        timestamp: start,
        category: "network",
        message: `${method} ${filterQueryParams(url, config.query_params_allowlist)} ${xhr.status}`,
        data,
      });
      touchActivity();
    });

    xhr.addEventListener("error", () => {
      addBreadcrumb({
        timestamp: start,
        category: "network",
        message: `${method} ${filterQueryParams(url, config.query_params_allowlist)} (error)`,
        data: { initiator: "xhr", method, url: filterQueryParams(url, config.query_params_allowlist), error: true },
      });
    });

    return origXhrSend.call(this, body);
  };

  cleanups.push(() => {
    window.fetch = origFetch;
    XMLHttpRequest.prototype.open = origXhrOpen;
    XMLHttpRequest.prototype.send = origXhrSend;
  });
}

// --- Console tracking ---

function initConsole(): void {
  origConsoleWarn = console.warn.bind(console);
  origConsoleError = console.error.bind(console);

  console.warn = function (...args: unknown[]) {
    addBreadcrumb({
      timestamp: Date.now(),
      category: "console",
      message: formatConsoleArgs(args).slice(0, 200),
      data: { level: "warn" },
    });
    origConsoleWarn(...args);
  };

  console.error = function (...args: unknown[]) {
    addBreadcrumb({
      timestamp: Date.now(),
      category: "console",
      message: formatConsoleArgs(args).slice(0, 200),
      data: { level: "error" },
    });
    origConsoleError(...args);
  };

  cleanups.push(() => {
    console.warn = origConsoleWarn;
    console.error = origConsoleError;
  });
}

function formatConsoleArgs(args: unknown[]): string {
  return args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
}

// --- Long task tracking ---

function initLongTasks(): void {
  if (typeof PerformanceObserver === "undefined") return;

  // Try Long Animation Frame API first (Chrome 123+) — has script attribution
  try {
    const observer = new PerformanceObserver((list) => {
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
  if (maxScrollPercent > 0 && lastScrollUrl) {
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

  const scrollVisHandler = () => {
    if (document.visibilityState === "hidden") flushScrollDepth();
  };
  document.addEventListener("visibilitychange", scrollVisHandler);

  cleanups.push(
    () => document.removeEventListener("scroll", scrollHandler, { capture: true }),
    () => document.removeEventListener("visibilitychange", scrollVisHandler),
  );
}

// --- Form abandonment tracking ---

function initFormAbandonment(): void {
  // A form counts as "interacted" only when the user actually types into it.
  // Focusing an input (tabbing through the page, clicking into a search box
  // to paste, etc.) isn't enough — users do that constantly on apps with a
  // global search/filter bar without intending to fill a form. We also skip
  // GET forms, which are almost always filters / search (Rails-style
  // shareable URLs) rather than real data-entry. The combination cuts the
  // false-positive rate to near zero on content-heavy dashboards.
  const interactedForms = new Map<HTMLFormElement, number>();
  const submittedForms = new WeakSet<HTMLFormElement>();

  const inputHandler = (e: Event) => {
    const target = e.target as Element;
    if (!(target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || target instanceof HTMLSelectElement)) return;
    const form = target.closest("form");
    if (!form) return;
    // Skip GET forms — typically search / filter, not abandonment candidates.
    const method = (form.method || "get").toLowerCase();
    if (method === "get") return;
    if (!interactedForms.has(form)) interactedForms.set(form, Date.now());
  };
  document.addEventListener("input", inputHandler, { capture: true, passive: true });

  const submitHandler = (e: SubmitEvent) => {
    const form = e.target as HTMLFormElement;
    submittedForms.add(form);
    interactedForms.delete(form);
  };
  document.addEventListener("submit", submitHandler, { capture: true, passive: true });

  // On navigation, emit abandonment for forms interacted with but not submitted
  const emitAbandonments = () => {
    for (const [form, interactionTime] of interactedForms) {
      if (submittedForms.has(form)) continue;
      const selector = elementSelector(form);
      addBreadcrumb({
        timestamp: interactionTime,
        category: "form_abandonment",
        message: selector,
        data: { action: form.getAttribute("action") || undefined, method: form.method || "get" },
      });
    }
    interactedForms.clear();
  };

  onBeforeNavigation(emitAbandonments);
  const beforeUnloadHandler = () => emitAbandonments();
  window.addEventListener("beforeunload", beforeUnloadHandler);

  cleanups.push(
    () => document.removeEventListener("input", inputHandler, { capture: true }),
    () => document.removeEventListener("submit", submitHandler, { capture: true }),
    () => window.removeEventListener("beforeunload", beforeUnloadHandler),
  );
}

// --- User timing tracking ---

function initUserTiming(): void {
  if (typeof PerformanceObserver === "undefined") return;

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const isMeasure = entry.entryType === "measure";
        addBreadcrumb({
          timestamp: Math.round(performance.timeOrigin + entry.startTime),
          category: "user_timing",
          message: isMeasure
            ? `${entry.name} (${Math.round(entry.duration)}ms)`
            : entry.name,
          data: {
            type: entry.entryType,
            duration: isMeasure ? Math.round(entry.duration) : undefined,
          },
        });
      }
    });
    observer.observe({ entryTypes: ["mark", "measure"] });
    cleanups.push(() => observer.disconnect());
  } catch {
    // mark/measure observation not supported
  }
}

// --- Visibility tracking ---

function initVisibility(): void {
  const handler = () => {
    const state = document.visibilityState;
    addBreadcrumb({
      timestamp: Date.now(),
      category: "visibility",
      message: `Tab became ${state}`,
      data: { state },
    });
  };
  document.addEventListener("visibilitychange", handler);
  cleanups.push(() => document.removeEventListener("visibilitychange", handler));
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
  // We don't branch on e.persisted — bfcache resumes will emit fresh breadcrumbs on the same tab_id.
  const handler = () => {
    addBreadcrumb({
      timestamp: Date.now(),
      category: "tab",
      message: "Tab closed",
      data: { event: "close" },
    });
  };
  window.addEventListener("pagehide", handler);
  cleanups.push(() => window.removeEventListener("pagehide", handler));
}

// --- Destroy ---

export function destroyBreadcrumbs(): void {
  for (const fn of cleanups) fn();
  cleanups = [];
  // Restore navigation hooks
  if (navigationHookInstalled) {
    history.pushState = origPushState;
    history.replaceState = origReplaceState;
    if (popstateHandler) {
      window.removeEventListener("popstate", popstateHandler);
      popstateHandler = null;
    }
    navigationHookInstalled = false;
  }
  preNavListeners = [];
  postNavListeners = [];
  resourceTimings.clear();
  recentClicks = [];
  buffer = new RingBuffer<Breadcrumb>(100);
}
