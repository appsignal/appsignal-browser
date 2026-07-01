# @appsignal/browser

Standalone JavaScript SDK that collects frontend errors, breadcrumbs, web vitals, and session data from customer web apps.

## Goal

Frontend observability essentials: error tracking, breadcrumbs, web vitals. Ships as ES module and UMD bundle. Posts to `/ingest/browser` on the AppSignal backend. Session replay is out of scope for v1.

All collection behavior is set in `init()`; the SDK does not fetch any server-side config. Sample rates, breadcrumb categories, privacy selectors, and other knobs are part of the `BrowserConfig` object passed at startup. Only the ingestion key is required — every other knob has a sensible default.

## Interface

### Installation

```html
<!-- Script tag -->
<script src="https://cdn.example.com/@appsignal/browser@1/dist/browser.umd.js"></script>
<script>
  AppsignalBrowser.init({ key: "your-public-ingestion-key" });
</script>
```

```js
// ES module
import { init } from "@appsignal/browser";
init({ key: "your-public-ingestion-key" });
```

### Configuration

```ts
interface BrowserConfig {
  // Required
  key: string;           // Public ingestion key (safe to expose in frontend code)
  endpoint?: string;     // Override /ingest/browser URL (default: auto-detected from script src or window location)

  // Master switch. Default: active. Set false to make init() a complete no-op
  // — nothing patched, no timers, no network. Gate on your build environment
  // to keep dev/test/CI from sending data:
  //   active: import.meta.env.PROD        // Vite
  //   active: process.env.NODE_ENV === "production"
  active?: boolean;

  // App version or deploy identifier (optional but recommended)
  // Set to your release tag, commit SHA, or deploy ID so sessions and errors
  // can be correlated with specific deployments.
  // Example: "v1.4.2", "2024-03-15.abc1234"
  appVersion?: string;

  // User context (optional, set after login)
  user?: {
    id?: string;
    email?: string;
    name?: string;
  };

  // Inspect or modify each error at the entry point — before the SDK adds
  // an error breadcrumb, records lastErrorTimestamp, or runs deduplication.
  // Return null to drop the error: none of those side effects fire. Mutate
  // fields to filter or redact (message, stack, etc.). Receives an
  // IncomingError, not the full payload; breadcrumbs and session are
  // attached later. Sync only.
  beforeError?: (event: IncomingError) => IncomingError | null;

  // Inspect or modify each breadcrumb at the moment it's pushed into the
  // ring buffer, before any flush. Fires for every breadcrumb the SDK
  // collects (network, click, navigation, console, error, manual). Return
  // null to drop — the breadcrumb never enters the buffer and ships in
  // neither error payloads nor periodic events payloads. Runs on the hot
  // path; keep it cheap.
  beforeBreadcrumb?: (breadcrumb: Breadcrumb) => Breadcrumb | null;

  // URL patterns to inject W3C traceparent headers into (for distributed tracing).
  // Glob syntax. Only requests matching these patterns get trace headers.
  // Example: ["api.example.com/**", "localhost:3000/**"]
  tracePropagationTargets?: string[];

  // Collection knobs. Every group is optional; omitted keys inherit defaults.
  errors?: {
    enabled?: boolean;             // default: true
    sampleRate?: number;           // 0..1, default: 1.0
  };
  breadcrumbs?: {
    network?: boolean;             // default: true — fetch/XHR breadcrumbs
    console?: boolean;             // default: true — patches warn/error
    clicks?: boolean;              // default: true
    longTasks?: boolean;           // default: true
    scrollDepth?: boolean;         // default: true
  };
  session?: {
    enabled?: boolean;             // default: false — ship the breadcrumb/session journey stream
    inactivityTimeoutMs?: number;  // default: 1_800_000 (30 minutes)
  };
  privacy?: {
    queryParamsAllowlist?: string[];  // glob list, default: [] (strip all)
    networkBlocklist?: string[];      // glob URL patterns — request never recorded
    dom?: {
      maskText?: string[];         // CSS selectors — text content masked
      blockElement?: string[];     // CSS selectors — element + subtree dropped
    };
  };
}
```

Both filtering hooks run **before any buffering** — `beforeError` at the SDK's entry point for errors, `beforeBreadcrumb` at the breadcrumb ring buffer's push site. Returning `null` from either drops the event completely; mutating fields propagates into the eventual payload. This split avoids the common asymmetry in other SDKs (a "drop early" list plus a "modify late" hook) by giving every event type the same early-pipeline shape.

All collection knobs are passed at `init()` time. There is no server-side config fetch and no remote kill switch. To stop collection mid-session, call `destroy()`. To change a knob, redeploy with the new value (or pass a different config object next time `init()` runs — for example, in a single-page app that re-mounts the SDK).

### API

```ts
// Called once, early in the page lifecycle
function init(config: BrowserConfig): void;

// Identify the current user after authentication. Rides the session/journey
// stream as user context (user_id / user_email / user_name). Does NOT tag
// errors — use setTags for that.
function setUser(user: { id?: string; email?: string; name?: string }): void;

// Clear user identity. Does not rotate the session — session identity is
// independent of user identity. Use endSession() on logout if you want a
// fresh session_id for the next events.
function clearUser(): void;

// Attach arbitrary string tags to every subsequent error payload, for
// filtering/searching errors (e.g. setTags({ plan: "pro", org_id: "acme" })).
// Merges with existing tags; pass an empty value to drop a key. Values are
// coerced to strings and the set is capped (32). To put user info on errors,
// set it here explicitly.
function setTags(tags: Record<string, string>): void;

// Remove all error tags.
function clearTags(): void;

// End the current session. Flushes pending events under the current
// session_id (via beacon), then clears session and user state. The next
// captured event starts a fresh session. Typical use: call on logout.
function endSession(): void;

// Add a manual breadcrumb
function addBreadcrumb(breadcrumb: {
  category: string;
  message: string;
  data?: Record<string, unknown>;
}): void;

// Force-flush buffered events (useful in SPA route changes or beforeunload)
function flush(): void;

// Report a caught error manually. Used by framework plugins and try/catch blocks.
function captureError(error: Error, context?: { componentName?: string; [key: string]: unknown }): void;

// Tear down the SDK. Flushes remaining data and stops all collection.
function destroy(): void;
```

## Behavior

### Init and config

`init(config)` merges the caller's `BrowserConfig` with built-in defaults once, synchronously, then starts every collector with the resolved config. There is no server-side config fetch, no fallback-then-real-config dance, and no remote kill switch — every knob lives in the JS call and is locked for the lifetime of the SDK instance. To change a knob, call `destroy()` and `init()` again with a new config, or redeploy with the new value.

The `key` and `endpoint` are meant to be hardcoded in your frontend bundle — the ingestion key is public and write-only by design. To stop dev/test/CI builds from sending real data, use the `active` master switch rather than swapping keys: `active: false` makes `init()` a complete no-op (no fetch/XHR patching, no timers, no network). Public methods (`setUser`, `addBreadcrumb`, `captureError`, …) already no-op while inactive, so application code can call them unconditionally. Gate it on the build environment — `active: import.meta.env.PROD` (Vite) or `active: process.env.NODE_ENV === "production"` — and the SDK stays dormant everywhere but production. `active: false` does not latch: a later `init()` with `active` unset (or true) still initializes normally.

Defaults are tuned to collect by default and lean on the privacy hooks to scope what ships:

- `errors.sampleRate: 1.0`; `errors.enabled: true`.
- Web vitals always ship. Breadcrumbs are always *collected* (errors carry their recent trail), but the breadcrumb/session journey stream is only *sent* when `session.enabled: true`. There is no top-level off switch for collection; use `destroy()` to stop the SDK, or `breadcrumbs.network: false` / per-category toggles to narrow what's collected.
- `privacy.queryParamsAllowlist: []` — strip every query param from captured URLs (network breadcrumbs, navigation breadcrumbs, `page_url`, `referrer`, vital `page_url`). OAuth-style query-shaped fragments are scrubbed by the same rule; hash routes and opaque anchors are preserved verbatim.
- `privacy.networkBlocklist: []` — glob URL patterns to suppress entirely from network breadcrumbs (host + path match).
- `session.enabled: false` — only errors + web vitals leave the browser; the breadcrumb/session journey stream stays local until opted in.
- `session.inactivityTimeoutMs: 1_800_000` (30 minutes).

Per-category breadcrumb toggles (`breadcrumbs.network`, `clicks`, `console`, etc.) are read by each handler at fire time, so the cost of an "off" toggle is one branch per event. They aren't intended to flip at runtime — they're locked at init — but the indirection keeps the call sites uniform and would let a future runtime override path slot in without restructuring the handlers.

### Session model

A session is a continuous period of user activity on a website.

**Session start:** First page load, or a page load after the inactivity timeout (`session.inactivity_timeout`, default 30 minutes). Each session gets a `session_id` (UUIDv7) generated client-side. The server should treat it as an opaque string. UUIDv7's 48-bit timestamp prefix makes it lexicographically sortable by creation time, so a time-ordered primary-key index (e.g. a B-tree) works without a separate timestamp column.

**Session continuation:** Activity resets the inactivity timer. Activity = click, keyboard input, scroll, navigation, or XHR/fetch completion. Every activity touch checks the gap since the previous activity. If it exceeds the timeout (e.g. laptop asleep for hours), a new session is created before recording. This is the primary expiry mechanism, regardless of timer or visibility event ordering.

**Session end:** On `visibilitychange` to hidden, the in-memory session ID is cleared so the next activity checks the timestamp. When visible again, if the inactivity timeout elapsed during sleep, the session is expired and a new one starts on the next event. These visibility checks are secondary; the activity-based check is authoritative. Session duration is computed server-side from first and last event timestamps.

**Session storage:** `session_id`, `last_activity`, and user context (from `setUser()`) live in `localStorage` so a session persists across tab close/reopen and is shared between tabs on the same origin. Session identity is bounded by the 30-minute inactivity timeout, not the tab lifecycle. `anonymous_id` (UUIDv4) is also in `localStorage` to correlate sessions from the same browser across longer gaps. Neither is a user identifier.

**Cross-tab sync:** Two tabs on the same origin share one `session_id`. The SDK listens for `storage` events on `appsignal_session_id`, `appsignal_last_activity`, and `appsignal_user`, mirroring changes from other tabs into in-memory state. `getSessionId()` also re-reads `last_activity` from `localStorage` before its timeout check, so a tab that stays visible but idle still picks up activity in another tab and doesn't drift onto a separate session. The visibility handler covers the hidden→visible transition; the storage events and the re-read cover concurrently-visible tabs.

**Per-tab id:** Each tab gets a `tab_id` (UUIDv7) minted once per tab in `sessionStorage`. It survives in-tab reloads, dies with the tab. Every payload includes both `session_id` and `tab_id` in the session block, so the server can group concurrent activity from multiple tabs under one session and reconstruct the per-tab journey. Replay chunks are uniquely keyed by `(session_id, tab_id, chunk_index)` — two tabs of one session can record in parallel without colliding on `chunk_index`. The chunk counter lives in `sessionStorage` keyed by `appsignal_replay_chunk_index_<session_id>_<tab_id>` and is naturally tab-scoped.

**Explicit session end:** `endSession()` flushes pending events under the current `session_id` (via beacon), then clears session and user state so the next event starts a fresh session. Call on logout. `clearUser()` only clears user identity — it does not rotate the session. `destroy()` tears down the SDK entirely and clears all session storage.

**Session data on all events:** Every event includes `session_id`, `tab_id`, `anonymous_id`, `page_url`, `referrer`, `user_agent`, `screen_width`, `screen_height`, `viewport_width`, `viewport_height`, `language` (`navigator.language`), `timezone` (`Intl.DateTimeFormat().resolvedOptions().timeZone`), and where supported: `connection_type` (`navigator.connection.effectiveType` — `"4g"`, `"3g"`, `"2g"`, `"slow-2g"`), `device_memory` (`navigator.deviceMemory`, approximate GB). User fields `user_id`, `user_email`, `user_name` are included only if set via `setUser()`.

**Storage robustness:** All `localStorage` and `sessionStorage` reads and writes go through a defensive helper that returns `null` / no-ops on failure. Storage-disabled browsers (Safari private mode in older versions, sandboxed iframes, quota exceeded) cannot crash the SDK on init; the SDK degrades to an in-memory-only session for the lifetime of the page.

### Breadcrumbs

Ordered timeline of events during a session. Snapshotted into error payloads, and (when `session.enabled`) drained into the periodic events flush. Individual categories are toggled via the `breadcrumbs.*` config at `init()`; buffer capacities are fixed (see *Breadcrumb capacity* below), not configurable.

The SDK keeps **two** buffers. The **session buffer** (last 100 breadcrumbs) feeds the periodic events flush. A separate, smaller **error buffer** (last 25) is what error payloads snapshot, and it is filtered to a fixed category allowlist — `navigation`, `click`, `network`, `console`, `error`, `long_task`, `visibility`. Derived UX categories (`rage_click`, `dead_click`, `error_click`, `scroll_depth`, `tab`) are deliberately excluded from error context, so an error's attached breadcrumbs are the last 25 *core* events, not the last 100 of everything.

**Click breadcrumbs.** On every `click`, record a breadcrumb with a human-readable label. Label resolution priority:

1. **`data-breadcrumb` attribute** — if the clicked element or an ancestor (up to 5 levels) has `data-breadcrumb="pay-now"`, use it as-is. Explicit override for developers.
2. **Semantic type + text** — detect from HTML tags (`button`, `a`, `input`, `select`, `nav`, `th`, `td`, `li`, `img`, `video`, `details`) and ARIA roles (`role="button"`, `role="tab"`, `role="menuitem"`, etc.). SVG elements (`svg`, `path`, `circle`, `rect`, `g`) are labeled as `icon`. Combined with text content: `button "Submit"`, `link "Dashboard"`, `tab "Settings"`, `icon "Close"`.
3. **Text walk-up** — if no text (SVG icons, empty divs), walk up to the nearest ancestor (max 5 levels) with meaningful text. Check `aria-label`, then `textContent` on interactive ancestors (`a`, `button`, `role="button"`). Stop at large containers (`body`, `main`, `section`).
4. **Basic selector** — fallback to `tag#id` when no semantic type or text is found.

Text capped at 50 characters. Also checks `title`, `aria-label`, `alt`, `placeholder`. No CSS class-based detection — class names are framework-specific and produce unreadable labels.

**Rage click detection.** 3+ clicks within 1 second, within 100px proximity, on any element. Frustration signal regardless of ARIA/HTML semantics — users rage-click on elements that look clickable but lack button roles. Emitted synchronously on the click that crosses the threshold; does not wait for or require a "no effect" outcome. Rapid repeated clicking is a signal of frustration even when the app is responding (users smash responsive buttons out of impatience too), and gating rage on DOM/network inactivity would suppress it whenever the breadcrumb insertion itself (or any app reaction) mutates the DOM. After emitting, the in-memory click buffer is cleared, so the next rage entry requires another three qualifying clicks.

**Dead click detection.** A click on an interactable element (buttons, links, inputs, selects, textareas, `role="button"`/`role="link"`, elements with `onclick` or `tabindex`, labels with `for`) producing no DOM mutation, navigation, or network request within 300ms. Recorded as `dead_click`. The interactable filter is kept — a click on a non-interactive element is often intentional (selecting text, closing a dropdown).

**Error click detection.** A click followed by a JS error within 1 second. Recorded as `error_click`. With rage and dead clicks, these are the three frustration signals for broken or confusing UI.

**Navigation breadcrumbs.** Current page URL recorded as the first navigation breadcrumb on init. Subsequent navigations via `popstate`, `pushState`, `replaceState` (patched), and `hashchange` record timestamp, previous URL, new URL.

**Document load breadcrumb.** On init, a `network` breadcrumb for the initial document load using `PerformanceNavigationTiming`, with the same timing breakdown as other network breadcrumbs (dns, connect, ssl, ttfb, download) and `initiator: "document"`. Timestamp uses navigation start time so it sorts first.

**Network breadcrumbs.** Patch `XMLHttpRequest` and `fetch`. Record: method, URL (scrubbed through `privacy.queryParamsAllowlist` — see *Privacy and PII* for fragment behavior), status code, duration, initiator type (`"fetch"`, `"xhr"`, or `"document"`). Default allowlist is empty, so all query params are stripped to avoid PII. When configured, only matching keys are preserved (entries are glob-matched, so `utm_*` keeps every UTM param). Skips requests to the AppSignal `/ingest/browser` endpoint and any URL matching `privacy.networkBlocklist` — matched against host + path using glob syntax (`*` matches one segment, `**` across segments). Blocked URLs never leave the browser.

**Resource timing waterfall.** Each network breadcrumb is enriched with a `resource_timing` sub-object containing the full `PerformanceResourceTiming` waterfall from the browser, when available. The sub-object is stored in `data.resource_timing` and has this shape:

```ts
interface ResourceTiming {
  dns?: number;              // Domain lookup duration (ms)
  connect?: number;          // TCP connection duration (ms)
  ssl?: number;              // TLS handshake duration (ms)
  ttfb?: number;             // Time to first byte from server (ms)
  download?: number;         // Response transfer duration (ms)
  transfer_size?: number;    // Bytes transferred over the wire (with headers)
  encoded_body_size?: number; // Compressed body size (bytes)
  decoded_body_size?: number; // Uncompressed body size (bytes)
  protocol?: string;         // Protocol used (e.g. "h2", "h3", "http/1.1")
}
```

Fields are only included when meaningful (> 0 for durations and sizes, non-empty for protocol). Read from `PerformanceObserver` resource entries matching the request URL. Enables waterfall visualizations showing where time was spent (network vs server vs download).

**Cross-origin limitation.** For cross-origin requests, the browser returns zeros for all timing fields unless the server sends `Timing-Allow-Origin` matching the page origin. Browser security restriction, not SDK. Same-origin requests always have full timing. The UI handles missing timing gracefully — shows duration only when `resource_timing` is absent.

Example network breadcrumb with resource timing:

```json
{
  "timestamp": 1711234567890,
  "category": "network",
  "message": "POST /api/users 200",
  "data": {
    "method": "POST",
    "url": "/api/users",
    "status": 200,
    "duration": 340,
    "resource_timing": {
      "dns": 12,
      "connect": 25,
      "ssl": 18,
      "ttfb": 245,
      "download": 40,
      "transfer_size": 1240,
      "protocol": "h2"
    }
  }
}
```

**Network payload capture.** Not supported. HTTP request and response bodies are never captured — only URL, method, status, timings, and trace ID land in the breadcrumb. Body capture in the browser is a PII liability that's hard to scope safely. Users who need body context for specific errors can attach it manually via `addBreadcrumb` from their own code, scoped to whatever redaction policy makes sense for their API.

**Console breadcrumbs.** Patch `console.warn` and `console.error`. Record first 200 chars. `console.log` is not patched (too noisy).

**Long task breadcrumbs.** Tries Long Animation Frame API (`long-animation-frame`, Chrome 123+) for script attribution (source URL, function name, invoker). Falls back to the basic `longtask` observer (no attribution). Records any main thread block >50ms: timestamp, duration (ms), and when available `source_url`, `source_function`, `invoker`. Long tasks cause unresponsive UI; seeing one right before an error is a strong signal.

**Scroll depth breadcrumbs.** Track max scroll percentage per page. Throttled scroll listener (200ms) updates the high-water mark. Flushed as `scroll_depth` on navigation (pushState, replaceState, popstate) or tab hidden. Data: `{ percent: 72, url: "..." }`. Tells you which pages users read vs. bounce.

**Visibility change breadcrumbs.** On `visibilitychange`, record whether the tab became hidden or visible. Useful for detecting if the user switched away mid-flow before an error.

**Tab lifecycle breadcrumbs.** On init, emit a `tab` breadcrumb with `event: "open"` and message `"Tab opened"`. On `pagehide`, emit one with `event: "close"` and message `"Tab closed"`. Combined with the `visibility` breadcrumbs (within-tab focus/blur) and the `tab_id` carried on every payload, these are the open/close bookends a journey timeline needs to draw per-tab swim-lanes.

**Error breadcrumbs.** When an error is captured, it is also added to the ring buffer (category `"error"`, message truncated to 200 chars). If error B fires after error A, error A appears in B's breadcrumb trail.

**Breadcrumb capacity.** Two fixed-size ring buffers (not configurable): the session buffer holds the last 100 breadcrumbs (drained into the periodic flush); the error buffer holds the last 25 *core-category* breadcrumbs (snapshotted into error payloads — see *Breadcrumbs* above for the category allowlist). Older entries are dropped from each.

### Web vitals

Collect Core Web Vitals and supplementary metrics:

| Metric | Description | Core Web Vital | Per route? |
|--------|-------------|----------------|------------|
| LCP | Largest Contentful Paint — loading performance | Yes | Load only |
| CLS | Cumulative Layout Shift — visual stability | Yes | Yes |
| INP | Interaction to Next Paint — responsiveness | Yes | Yes |
| FCP | First Contentful Paint | No | Load only |
| TTFB | Time to First Byte | No | Load only |

**Load metrics** (LCP, FCP, TTFB) come from the [web-vitals](https://github.com/GoogleChrome/web-vitals) library, which handles their bfcache/visibility edge cases. The browser measures them once, relative to the initial page load, and never re-fires them for SPA soft navigations — so they're attributed to the route the page loaded on and are *initial-load only*. This matches CrUX, Datadog, and Sentry: stable browsers can't measure LCP/FCP per soft navigation (it needs the experimental [Soft Navigations API](https://developer.chrome.com/docs/web-platform/soft-navigations)).

**CLS and INP** accrue over the page lifetime and *can* be attributed per route. `web-vitals` reports them as a single cumulative page-view value that can't be sliced per route, so the SDK observes the raw `layout-shift` and `event-timing` performance entries itself and buckets them into the active route, resetting at each navigation:

- **CLS** runs the official session-window algorithm (shifts with `hadRecentInput` ignored; a window ends after a 1s gap or 5s span; the route's CLS is its largest window) — scoped to the current route rather than the whole page-view.
- **INP** groups `event-timing` entries by `interactionId` (an interaction's latency is its longest event) and reports the route's near-worst interaction: interactions are sorted descending and the SDK reports the one at 0-based index `min(count-1, floor(count/50))`. Below 50 interactions that's index 0 (the single worst); the index advances by one per additional 50 interactions, discounting the extreme tail — the same rule the `web-vitals` library uses.

Call `setRouteTemplate()` on each router navigation so CLS/INP attribute to the route they occurred on and the server aggregates by route shape (`/users/:id`) rather than raw URL. CLS/INP require the `layout-shift` / `event-timing` entry types (Chromium); where they're unavailable those two metrics are simply not emitted. Attribution is best-effort — a late-delivered buffered entry is bucketed into the route active when the observer delivers it.

Per-sample attribution (which element caused a slow LCP, the INP interaction target) is **not** collected in v1: it's per-visit diagnostic data that belongs in a raw sample store, not the aggregated metrics pipeline this feeds.

**Known limitations (by design).**
- **Abrupt termination loses the page's vitals.** Vitals flush at route/page boundaries (`visibilitychange→hidden`, `pagehide`, SPA navigation), never on the periodic timer — so a page killed by a crash, OOM, or force-quit before any of those fire records no vitals for that view. This is the standard `web-vitals` tradeoff (reporting on `visibilitychange` is the reliable signal); the lost slice is the hard-crash tail and doesn't bias aggregate percentiles.
- **CLS/INP per-route attribution is best-effort.** A buffered `layout-shift`/`event-timing` entry delivered just after a navigation can be bucketed into the wrong route. Late-delivered entries are rare and the effect is occasional, not systematic.
- **Hash-router navigations are treated as boundaries via `hashchange`**, but only when the new hash looks like a route — it must start with `#/` or `#!/`. This segments `#/route` SPAs while in-page anchor jumps (`#section`) are *not* treated as boundaries and do not finalize the route's CLS/INP. The tradeoff: bare-word hash routers (`#dashboard`, no leading slash) are not segmented and fold into the surrounding route.

Vitals ride in the `vitals` array of the `events` payload. Each entry carries just `name`, `value`, `page_url`, and `timestamp` (the metric's occurrence time, derived from `performance.timeOrigin` + the entry's `startTime`, falling back to `performance.now()` when a metric arrives with no backing entry) — the four fields the server stores. `page_url` is the `setRouteTemplate()` template if set, otherwise the raw URL (the server auto-templates it); query params are filtered through `privacy.queryParamsAllowlist` first (all stripped by default).

Server-side the names become `browser_webvital_lcp` / `_cls` / `_inp` / `_fcp` / `_ttfb` and feed the metrics_v3 aggregation pipeline, which folds samples by `(name, page_url, app_version)` per minute into `metrics.browser_webvitals_minutely` with p90 / p95 percentiles. CLS is stored ×1000 so all five share an integer scale. Rating (good / needs-improvement / poor) is derived from `value` at query time against Google's thresholds — not stored.

### Error collection

Instrument `window.onerror` and `window.addEventListener("unhandledrejection")`. For each error:

1. Capture: message, filename, line, column, stack trace (as a string).
2. Attach current breadcrumbs (snapshot of the ring buffer).
3. Attach session context (for `onErrorReported` subscribers).
4. Send immediately (do not buffer).

Stack traces are sent as raw strings. Source map processing is server-side (future phase); the plugin does not do client-side source map application.

**Cross-origin scripts.** When a script from another origin throws, the browser collapses it to an opaque `"Script error."` with no stack and no location, unless that script is served with `crossorigin="anonymous"` **and** an `Access-Control-Allow-Origin` header. The SDK drops these opaque, unsymbolicatable `"Script error."` entries rather than fill the stream with indistinguishable noise. To capture real errors from third-party/CDN-hosted scripts, add `crossorigin="anonymous"` to those `<script>` tags and ensure the host serves the matching CORS header.

**Non-`Error` rejections.** A `Promise.reject` whose reason isn't an `Error` (e.g. `reject({ code: 500 })`) is JSON-stringified so the detail survives in `message`, falling back to `String()` for primitives and non-serialisable values (circular refs, `BigInt`). Without this, object reasons would collapse to `"[object Object]"`.

**URL privacy.** The error payload's `environment.url` is scrubbed through `privacy.queryParamsAllowlist`, identically to every other captured URL — raw query params and OAuth fragments never ride along.

**Error grouping (`action`).** Errors group server-side by `action`, which is the `setRouteTemplate()` template (e.g. `/users/:id`) when set, otherwise the raw `location.pathname`. Declaring a template keeps ID-heavy routes from fragmenting into one error group per id — the same route key vitals attribution uses.

**Error tags.** The wire payload's `tags` map carries only what the host set via `setTags()` — arbitrary string key-values, coerced to strings (server-truncated to 256 bytes), capped at 32 keys. The SDK injects no identity of its own: `session_id` / `tab_id` / `anonymous_id` are *not* sent as tags (they're high-cardinality and not in the server's metadata-distribution allowlist, so they'd be sample noise) — they ride the events/session stream's `SessionContext` instead, and are available to `onErrorReported` subscribers. User identity from `setUser()` does **not** tag errors; to filter errors by user, pass the fields you want to `setTags()` explicitly.

**beforeError hook.** If provided, called once per error at the entry point — *before* the error breadcrumb is added, *before* `lastErrorTimestamp` is updated, *before* deduplication. Returning `null` drops the error completely; none of those side effects fire. Mutating fields on the returned `IncomingError` propagates into the eventual payload. This is the single hook for both noise suppression and field redaction:

```ts
beforeError: (e) => {
  if (/ResizeObserver/.test(e.message)) return null;        // drop noise
  e.message = e.message.replace(emailRe, "[redacted]");     // redact error fields
  e.stack   = e.stack?.replace(emailRe, "[redacted]");
  return e;
}
```

`beforeError` does *not* see `breadcrumbs` or `session` — those are attached after the hook approves. Redact breadcrumb-level data in `beforeBreadcrumb` instead (see *Breadcrumbs*), which has the side benefit of also redacting breadcrumbs that ride in periodic events flushes.

**Error deduplication.** Within one session, if the same error (same message + same stack top frame) fires more than 5 times in 10 seconds, the 6th+ are silently dropped. First 5 are sent normally. Prevents error storms from overwhelming ingestion.

**Global error rate limit.** Independent of per-error dedup, the module caps total error sends at 100 per 10-second window across all distinct errors. Once the cap is hit, further errors in that window are dropped until it rolls over. Backstops a page emitting many *different* errors (which dedup, keyed per message+frame, wouldn't catch).

**Top-window scope (by design).** Instrumentation is attached to the top-level `window` only. Same-origin `<iframe>`s have their own `window` (and their own `fetch` / `XMLHttpRequest`), so errors thrown and network calls made *inside* a same-origin iframe are not captured. Cross-origin iframes are inaccessible regardless (same-origin policy). To monitor an embedded same-origin frame, initialize a separate SDK instance inside it.

### Session replay

Out of scope for v1. The `replay` module (`src/replay.ts`) is in fact fully implemented — it dynamically imports `@rrweb/record` and records — but `index.ts` never imports it, so it is tree-shaken out of the shipped bundle and rrweb is never loaded at runtime. (`@rrweb/record` remains a declared dependency for when replay is wired in.) Replay will return as a future major version once the storage path is in place.

### Event batching and transport

All non-error, non-replay events (breadcrumbs, vitals, session metadata) are batched into one `events` payload. Flush triggers:
- **Page hide** (`visibilitychange` to hidden) and **tab close / navigation away** (`pagehide`, when not bfcache-persisted) — best-effort via `sendBeacon`. web-vitals registers its own `visibilitychange` listeners during `initVitals()`, before the SDK's, so the final LCP lands in the buffer before this flush drains it; the current route's CLS/INP are materialised from the observers at the same moment.
- **SPA navigation** (route change) — finalises and ships the outgoing route's CLS/INP, then resets the observers so the new route measures from zero.
- **Explicit `flush()`**.
- **Every 30 seconds** while the page is active — carries the breadcrumb/session journey only (a no-op when `session.enabled` is off). Vitals are deliberately *excluded* from the periodic timer: they're meaningful only at a route or page boundary, so they ride the navigation and page-hide flushes instead.

**Transport.** During a live session, events and replay chunks go via plain `fetch`. On `pagehide` / `visibilitychange → hidden`, a best-effort flush uses `navigator.sendBeacon`, which the browser delivers even as the page is unloading. Chromium caps both `sendBeacon` and `fetch({keepalive:true})` bodies at ~64 KB, so larger payloads are dropped on unload rather than attempted — the keepalive fallback Chrome would have rejected anyway. The lost payload is whatever accumulated since the last periodic flush: up to 5 s of replay events (often the trailing slice of a FullSnapshot-bearing chunk) or up to 30 s of breadcrumbs/vitals. Small payloads (the common case for events) fit under the cap and survive.

The ingestion key is always a query parameter: `POST /ingest/browser?api_key=<key>` (errors go to `/ingest/browser/errors`, same param). Events use `Content-Type: text/plain` (body is JSON, but `text/plain` avoids a CORS preflight, critical for cross-origin collection); errors use `application/json`. The backend parses JSON regardless of Content-Type.

**Retry.** Failed batches retry up to 3 times with exponential backoff and jitter. 5xx uses 1-second base (1s, 2s, 4s). 429 uses 5-second base (5s, 10s, 20s) to respect server capacity. Client errors (4xx other than 429) are not retried. If the browser goes offline mid-request, or all in-line retries are exhausted while the server is still failing, the payload goes into an in-memory retry queue bounded to 32 MB total. The queue drains on the next `online` event and on a 30 s periodic timer, so transient outages that don't trigger a network-state change (e.g. a server restart with an otherwise-healthy network) still recover. Eviction is FIFO: when a new payload would push the queue past 32 MB, the oldest entries drop until it fits. Single payloads above the 10 MB per-payload cap (matching the server's `DefaultBodyLimit`) are dropped before sending.

**Retry queue and replay reconstructability.** Replay chunks anchor on the most recent `FullSnapshot` (one at recording start, one every 60 s). Mutation-only chunks between two anchors depend on the chunk that contained their anchor. If the offline buffer evicts that anchor chunk (because newer ones pushed total bytes past 32 MB), the dependent mutation chunks become unrenderable on the server until the next surviving `FullSnapshot`. In practice, periodic snapshots mean the loss is bounded to whatever sits between two anchors. Long offline windows on heavy DOMs (large `FullSnapshot` chunks, many mutations) hit this sooner; brief offline drops typically fit comfortably.

**Network breadcrumb status semantics.** A network breadcrumb's message uses the form `<METHOD> <url> <status>` for any request that received a response, including non-2xx responses (e.g. `GET /api/missing 404` — the status code is preserved in the timeline). The `(error)` suffix is reserved for *transport failures* — a thrown `fetch` rejection or an XHR `error` event where no response was received. Consumers can distinguish via `data.status` (always present when the request completed) and `data.error: true` (set only for transport failures).

**Breadcrumb flush semantics.** Each periodic flush and page-hide event drains the ring buffer — each breadcrumb is sent exactly once and removed. Error payloads snapshot the buffer (without draining) so they always include recent context. Avoids duplicate breadcrumbs across flushes while preserving error context.

### Distributed tracing

When `tracePropagationTargets` is configured, the plugin injects a [W3C `traceparent`](https://www.w3.org/TR/trace-context/) header into outgoing `fetch` and `XMLHttpRequest` requests whose URL matches any pattern. Connects frontend requests to backend traces.

Header format: `00-{traceId}-{spanId}-01` where `traceId` is a random 32-hex-char string and `spanId` a random 16-hex-char string. Backend APM (AppSignal, OpenTelemetry, any W3C-compatible tracer) reads the header and continues the trace, so the frontend click and backend handler appear as one connected trace.

Only requests matching `tracePropagationTargets` get the header. Prevents leaking trace context to third-party APIs. Glob syntax (same as `privacy.networkBlocklist`).

**Concurrent same-URL requests** (e.g. a polling component firing two `GET`s before the first returns) each get their own `traceId`. Trace IDs are queued FIFO per URL; the network breadcrumb pipeline shifts them in the order they were recorded, so each breadcrumb's `data.trace_id` matches the request that produced it. Without this, two requests to the same URL would clobber each other's ID and the second breadcrumb would either inherit the first's trace or have none.

### Bundle size

Two formats:

- **UMD** (`browser.umd.js`): single file, ~17 KB gzipped. Load via `<script>`.
- **ESM** (`esm/index.js`): ~17 KB gzipped.

Replay is out of scope for v1 — `index.ts` doesn't import the `replay` module, so rrweb is tree-shaken out and not bundled. The figures above are the full SDK. When replay is wired in it will load its recorder as a separate chunk so the core stays small.

### Tracking consent

The SDK has no built-in consent state. If your app needs a GDPR-style consent gate, defer `init()` until the user has granted consent — collection only starts when the SDK is initialised. To stop collection mid-session (e.g. user revokes), call `destroy()`. User identity attached via `setUser()` is wiped by `destroy()` and by `endSession()`.

### Privacy and PII

PII controls live under a single cross-cutting `privacy.*` namespace.

```ts
privacy: {
  queryParamsAllowlist: string[]   // URL scrubbing — see below
  networkBlocklist: string[]       // glob URL patterns — request never recorded
  dom: {
    maskText: string[]             // CSS selectors — text content masked
    blockElement: string[]         // CSS selectors — element + subtree dropped
  }
}
```

**`privacy.queryParamsAllowlist`** — applied wherever a URL is captured: network breadcrumb URLs, SPA navigation breadcrumbs (`data.from`, `data.to`), `session_context.page_url`, `session_context.referrer`, `web_vitals.page_url`, and the error payload's `environment.url`. Entries are glob-matched (`utm_*` keeps every UTM param). Default empty: every query param is stripped. Fragments are handled by a heuristic: hash routes (`#/checkout`) and opaque anchors (`#section-1`) are preserved verbatim; query-like fragments (`#access_token=…&token_type=bearer`) are scrubbed by the same allowlist. This defends against OAuth implicit-flow leaks without breaking apps that use hash-based routing.

**`privacy.networkBlocklist`** — glob URL patterns that should never be recorded. Matched against host + pathname (`*` matches one segment, `**` across segments). Default empty. Today this suppresses the network breadcrumb entirely; when replay returns it will also gate replay's network capture. The request itself still happens — only its capture in SDK data is suppressed.

**`privacy.dom.maskText`** — CSS selectors whose **text content** is masked everywhere the SDK captures from the DOM. Session replay masks text to `*` (via rrweb's `maskTextSelector`). Click breadcrumbs replace the captured text with `"[masked]"` when the click target matches or descends from a listed selector — the breadcrumb still fires (you see *that* a click happened) but no PII text rides along.

**`privacy.dom.blockElement`** — CSS selectors whose **elements** are excluded from capture entirely. Session replay records a placeholder of the same dimensions (via rrweb's `blockSelector`); the subtree is never recorded. Click breadcrumbs are suppressed entirely — including rage / dead / error_click derivatives — when the click target matches or descends from a blocked element. Use for payment iframes, SSN fields, or any widget whose interaction shouldn't surface at all.

Both DOM selectors use `el.closest()` semantics, so masking or blocking a wrapper covers every descendant — matches the rrweb model.

Other defaults that round out the privacy posture:

- **HTTP bodies (request and response) are never captured.** No config exposes them.
- Console messages truncated at 200 chars.
- User fields (id, email, name) never collected unless `setUser()` is called; cleared via `clearUser()`.
- No cookies read or written beyond `anonymous_id` in `localStorage`.

**Filtering hooks.** Two early-pipeline callbacks, both run before any buffering:

- `beforeError(event) → IncomingError | null` — fires once per error at the SDK's entry point, before the error breadcrumb is added, before `lastErrorTimestamp`, before dedupe. Mutate to redact `message`/`stack`/etc.; return `null` to drop (no breadcrumb pollution, no dedupe slot consumed). Sync only — a `Promise` return is detected, logged as a `console.error`, and the event is dropped.
- `beforeBreadcrumb(breadcrumb) → Breadcrumb | null` — fires once per breadcrumb at insertion (network, click, navigation, console, error, manual). Mutate to redact `message`/`data`; return `null` to drop. One hook covers both channels: breadcrumbs riding in error payloads *and* breadcrumbs riding in the periodic events flush.

## Framework plugins

Separate packages bridging framework-specific error handling into the core SDK via `captureError`. Small (<1 KB) with the core SDK as a peer dependency.

### React (`@appsignal/browser/react`)

An `ErrorBoundary` class component that catches React render errors via `componentDidCatch` and reports them through the core SDK's error pipeline. React does not expose error boundary functionality as hooks, so a class component is required.

**Props:**
- `captureError` (required) — the `captureError` function imported from `@appsignal/browser`. Passed as a prop to avoid coupling to module resolution (works for ESM and UMD).
- `fallback` — React node or render function `(error, reset) => ReactNode`. Shown when an error is caught.
- `onError` — optional callback `(error, componentStack) => void`. Called before sending to AppSignal.

**Error context:** Each captured error includes `componentName` (parsed from the component stack) and `componentStack` (the full React hierarchy at the time of the error) in the `context` field.

**`withErrorBoundary` HOC:** Wraps any component in an `ErrorBoundary`. Same props minus `children`.

```tsx
import { captureError } from "@appsignal/browser";
import { ErrorBoundary, withErrorBoundary } from "@appsignal/browser/react";

// Direct usage
<ErrorBoundary captureError={captureError} fallback={<p>Something went wrong</p>}>
  <App />
</ErrorBoundary>

// HOC
const SafeWidget = withErrorBoundary(Widget, {
  captureError,
  fallback: <p>Widget failed to load</p>,
});
```
