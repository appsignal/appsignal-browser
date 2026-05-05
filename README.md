# @appsignal/browser

Standalone JavaScript SDK that collects frontend errors, breadcrumbs, web vitals, session data, and session replay recordings from customer web apps.

## Goal

One package covering all frontend observability: error tracking, breadcrumbs, web vitals, session replay. Ships as ES module and UMD bundle. Posts to `/ingest/browser` on the AppSignal backend.

Collection behavior is controlled server-side via the config system. On init, the SDK fetches its effective config from `GET /ingest/browser/config?key=<key>` and applies whatever the operator has set. Replay can be disabled in staging, sample rates tuned per namespace, breadcrumb categories toggled — all without shipping a new frontend build. Only the ingestion key is required in the SDK call.

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

  // Modify or drop error events before sending. Return null to drop the event.
  beforeSend?: (event: BrowserError) => BrowserError | null;

  // Error message patterns to ignore. Matching errors are silently dropped.
  // Accepts strings (substring match) or RegExp patterns.
  ignoreErrors?: (string | RegExp)[];

  // URL patterns to inject W3C traceparent headers into (for distributed tracing).
  // Glob syntax. Only requests matching these patterns get trace headers.
  // Example: ["api.example.com/**", "localhost:3000/**"]
  tracePropagationTargets?: string[];

  // Initial tracking consent state. Default: "granted" (backwards compatible).
  // Set to "pending" to buffer data until the user makes a consent choice.
  trackingConsent?: "granted" | "not-granted" | "pending";
}
```

All collection toggles, sample rates, replay settings, and breadcrumb options are configured server-side and fetched on init. The full field reference lives with the backend config. Client-side options (`beforeSend`, `ignoreErrors`, `tracePropagationTargets`, `trackingConsent`) are set in `init()` since they contain code or are page-load settings.

### API

```ts
// Called once, early in the page lifecycle
function init(config: BrowserConfig): void;

// Set or update user context after authentication
function setUser(user: { id?: string; email?: string; name?: string }): void;

// Clear user context. Does not rotate the session — session identity is
// independent of user identity. Use endSession() on logout if you want a
// fresh session_id for the next events.
function clearUser(): void;

// End the current session. Flushes pending events and replay chunks under
// the current session_id, then clears session and user state. The next
// captured event starts a fresh session. Typical use: call on logout.
function endSession(): void;

// Add a manual breadcrumb
function addBreadcrumb(crumb: {
  category: string;
  message: string;
  data?: Record<string, unknown>;
}): void;

// Force-flush buffered events (useful in SPA route changes or beforeunload)
function flush(): void;

// Update tracking consent state. Call when the user makes a consent choice.
function setConsent(consent: "granted" | "not-granted" | "pending"): void;

// Report a caught error manually. Used by framework plugins and try/catch blocks.
function captureError(error: Error, context?: { componentName?: string; [key: string]: unknown }): void;

// Tear down the SDK. Flushes remaining data and stops all collection.
function destroy(): void;
```

## Behavior

### Init and config

On `init()`, all collectors (breadcrumbs, errors, vitals, replay) start immediately using a hardcoded fallback config so no early session data is lost. Replay recording begins from the first DOM mutation.

In parallel, the plugin fetches the effective server config:

```
GET /ingest/browser/config?key=<ingestion-key>
```

When the config arrives, it propagates to all modules:
- If `enabled` is false, buffers are discarded and collection stops.
- Breadcrumbs: real `network_blocklist`, `query_params_allowlist`, and `network_payloads` replace fallbacks. Blocked/stripped requests are handled correctly from this point.
- Errors: real `sample_rate` takes effect for subsequent errors.
- Replay sampling: a per-session random (rolled once at init) is compared against the real `sample_rate`. Unsampled sessions discard their replay buffer. Sessions with `error_replay` keep recording but only flush replay data if an error occurs.

The fallback is safe and captures everything:
- All collectors enabled so no data is missed.
- `replay.sample_rate: 1.0` so all sessions record from the first DOM mutation. Real rate narrows this on config arrival.
- `network_payloads.enabled: false` — payload capture is privacy-sensitive and should not start without explicit server-side opt-in.
- `replay.mask_all_inputs: true` and `query_params_allowlist: []` (strip all params) — safe defaults protect PII.

During the config fetch window (~100ms), the plugin may collect slightly more than the server config allows (breadcrumbs from blocklisted URLs, errors at 100% vs. server rate). Acceptable: collecting too much briefly beats missing early session data.

If the config request fails, the plugin continues with the fallback. Not cached across page loads; fetched fresh on every `init()`.

The response is a JSON object matching the resolved `BrowserConfig` for the key's node:

```json
{
  "enabled": true,
  "errors": { "enabled": true, "sample_rate": 1.0 },
  "breadcrumbs": {
    "enabled": true,
    "network": true,
    "network_blocklist": [],
    "query_params_allowlist": [],
    "network_payloads": {
      "enabled": false,
      "request_body": true,
      "response_body": true,
      "max_size_bytes": 65536,
      "content_types": ["application/json", "text/plain", "text/html"]
    },
    "console": true,
    "clicks": true,
    "long_tasks": true,
    "scroll_depth": true,
    "form_abandonment": true,
    "user_timing": false,
    "capacity": 100
  },
  "web_vitals": { "enabled": true },
  "replay": {
    "enabled": true,
    "sample_rate": 0.1,
    "error_replay": true,
    "mask_all_inputs": true,
    "mask_selectors": [],
    "block_selectors": []
  },
  "session": { "inactivity_timeout_ms": 1800000 }
}
```

### Session model

A session is a continuous period of user activity on a website.

**Session start:** First page load, or a page load after the inactivity timeout (`session.inactivity_timeout`, default 30 minutes). Each session gets a `session_id` (UUIDv7) generated client-side.

**Session continuation:** Activity resets the inactivity timer. Activity = click, keyboard input, scroll, navigation, or XHR/fetch completion. Every activity touch checks the gap since the previous activity. If it exceeds the timeout (e.g. laptop asleep for hours), a new session is created before recording. This is the primary expiry mechanism, regardless of timer or visibility event ordering.

**Session end:** On `visibilitychange` to hidden, the in-memory session ID is cleared so the next activity checks the timestamp. When visible again, if the inactivity timeout elapsed during sleep, the session is expired and a new one starts on the next event. These visibility checks are secondary; the activity-based check is authoritative. Session duration is computed server-side from first and last event timestamps.

**Session storage:** `session_id`, `last_activity`, and user context (from `setUser()`) live in `localStorage` so a session persists across tab close/reopen and is shared between tabs on the same origin. Session identity is bounded by the 30-minute inactivity timeout, not the tab lifecycle. `anonymous_id` (UUIDv7) is also in `localStorage` to correlate sessions from the same browser across longer gaps. Neither is a user identifier.

**Cross-tab sync:** Two tabs on the same origin share one `session_id`. The SDK listens for `storage` events on `appsignal_session_id`, `appsignal_last_activity`, and `appsignal_user`, mirroring changes from other tabs into in-memory state. `getSessionId()` also re-reads `last_activity` from `localStorage` before its timeout check, so a tab that stays visible but idle still picks up activity in another tab and doesn't drift onto a separate session. The visibility handler covers the hidden→visible transition; the storage events and the re-read cover concurrently-visible tabs.

**Per-tab id:** Each tab gets a `tab_id` (UUIDv7) minted once per tab in `sessionStorage`. It survives in-tab reloads, dies with the tab. Every payload includes both `session_id` and `tab_id` in the session block, so the server can group concurrent activity from multiple tabs under one session and reconstruct the per-tab journey. Replay chunks are uniquely keyed by `(session_id, tab_id, chunk_index)` — two tabs of one session can record in parallel without colliding on `chunk_index`. The chunk counter lives in `sessionStorage` keyed by `appsignal_replay_chunk_index_<session_id>_<tab_id>` and is naturally tab-scoped.

**Explicit session end:** `endSession()` flushes pending events and replay chunks under the current `session_id`, then clears session and user state so the next event starts a fresh session. Call on logout. `clearUser()` only clears user identity — it does not rotate the session. `destroy()` tears down the SDK entirely and clears all session storage.

**Session data on all events:** Every event includes `session_id`, `tab_id`, `anonymous_id`, `page_url`, `referrer`, `user_agent`, `screen_width`, `screen_height`, `viewport_width`, `viewport_height`, `language` (`navigator.language`), `timezone` (`Intl.DateTimeFormat().resolvedOptions().timeZone`), and where supported: `connection_type` (`navigator.connection.effectiveType` — `"4g"`, `"3g"`, `"2g"`, `"slow-2g"`), `device_memory` (`navigator.deviceMemory`, approximate GB). User fields `user_id`, `user_email`, `user_name` are included only if set via `setUser()`.

**Storage robustness:** All `localStorage` and `sessionStorage` reads and writes go through a defensive helper that returns `null` / no-ops on failure. Storage-disabled browsers (Safari private mode in older versions, sandboxed iframes, quota exceeded) cannot crash the SDK on init; the SDK degrades to an in-memory-only session for the lifetime of the page.

### Breadcrumbs

Ordered timeline of events during a session. Flushed with the session payload and sent immediately before error events. Individual categories and ring buffer capacity are controlled via server config.

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

**Network breadcrumbs.** Patch `XMLHttpRequest` and `fetch`. Record: method, URL (query params filtered through `breadcrumbs.query_params_allowlist`), status code, duration, initiator type (`"fetch"`, `"xhr"`, or `"document"`). Default allowlist is empty, so all query params are stripped to avoid PII. When configured, only matching params are preserved. Fragments always stripped. Skips requests to the AppSignal `/ingest/browser` endpoint and any URL matching `breadcrumbs.network_blocklist` — matched against host + path using glob syntax (`*` matches one segment, `**` across segments). Blocked URLs never leave the browser.

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

**Network payload capture.** When `breadcrumbs.network_payloads.enabled` is true, request and response bodies are captured alongside timing. For `fetch`, the response is cloned (`response.clone()`) before the app reads it, so capture is transparent. For `XHR`, `responseText` is read after `load`. Only captured when `Content-Type` matches `breadcrumbs.network_payloads.content_types`; binary types (images, video, `application/octet-stream`) are always skipped. Bodies larger than `network_payloads.max_size_bytes` are truncated with `truncated: true`. URLs in `network_blocklist` are never captured regardless. Off by default.

**Console breadcrumbs.** Patch `console.warn` and `console.error`. Record first 200 chars. `console.log` is not patched (too noisy).

**Long task breadcrumbs.** Tries Long Animation Frame API (`long-animation-frame`, Chrome 123+) for script attribution (source URL, function name, invoker). Falls back to the basic `longtask` observer (no attribution). Records any main thread block >50ms: timestamp, duration (ms), and when available `source_url`, `source_function`, `invoker`. Long tasks cause unresponsive UI; seeing one right before an error is a strong signal.

**Scroll depth breadcrumbs.** Track max scroll percentage per page. Throttled scroll listener (200ms) updates the high-water mark. Flushed as `scroll_depth` on navigation (pushState, replaceState, popstate) or tab hidden. Data: `{ percent: 72, url: "..." }`. Tells you which pages users read vs. bounce.

**Form abandonment breadcrumbs.** Detect users who start a form but never submit. Track `input` events on form fields (input, textarea, select) — a keystroke, not just focus — to mark a form as interacted; `submit` marks it submitted. `GET` forms are skipped because they're almost always search / filter UIs producing shareable URLs, not data-entry intent. On navigation or `beforeunload`, emit a `form_abandonment` breadcrumb for each interacted-but-not-submitted form. Data: `{ action: "...", method: "post" }`.

**User timing breadcrumbs.** Observe `performance.mark()` and `performance.measure()` via `PerformanceObserver`. These are developer-instrumented timings the app already considers worth measuring. Each mark emits a `user_timing` breadcrumb with the mark name. Each measure emits one with name and duration: `"dashboard-load (340ms)"`. Data: `{ type: "mark"|"measure", duration?: number }`. Bridges "a network request happened" and "the meaningful operation completed" in the timeline.

**Visibility change breadcrumbs.** On `visibilitychange`, record whether the tab became hidden or visible. Useful for detecting if the user switched away mid-flow before an error.

**Tab lifecycle breadcrumbs.** On init, emit a `tab` breadcrumb with `event: "open"` and message `"Tab opened"`. On `pagehide`, emit one with `event: "close"` and message `"Tab closed"`. Combined with the `visibility` breadcrumbs (within-tab focus/blur) and the `tab_id` carried on every payload, these are the open/close bookends a journey timeline needs to draw per-tab swim-lanes.

**Error breadcrumbs.** When an error is captured, it is also added to the ring buffer (category `"error"`, message truncated to 200 chars). If error B fires after error A, error A appears in B's breadcrumb trail.

**Breadcrumb capacity.** Ring buffer of last 100 breadcrumbs per session. Older ones are dropped.

### Web vitals

Collect Core Web Vitals and supplementary metrics from the [web-vitals](https://github.com/GoogleChrome/web-vitals) library:

| Metric | Description | Core Web Vital |
|--------|-------------|----------------|
| LCP | Largest Contentful Paint — loading performance | Yes |
| CLS | Cumulative Layout Shift — visual stability | Yes |
| INP | Interaction to Next Paint — responsiveness | Yes |
| FCP | First Contentful Paint | No |
| TTFB | Time to First Byte | No |

Each metric is associated with a page navigation. Interaction-dependent metrics (INP) are only recorded after at least one interaction. CLS accumulates over the life of the page.

LCP, CLS, and INP are registered with `reportAllChanges: true` so their values flow into the SDK as they update, not only at page lifecycle end. Each time a callback fires, the SDK replaces any existing queued vital with the same `(name, page_url)` pair — only the latest value per (metric, page) is held for the next flush. This avoids a race where `web-vitals` would otherwise defer final LCP / CLS / INP finalization to its `whenIdleOrHidden` helper (which runs via `requestIdleCallback` / `setTimeout(0)`), landing after the SDK's own unload-time flush and losing the metric. FCP and TTFB fire once, early in the page, and do not need this treatment.

Vitals use the `web-vitals/attribution` build, providing attribution alongside the value:
- **LCP**: `element` — CSS selector of the largest contentful element.
- **CLS**: `element` — CSS selector of the largest layout shift target.
- **INP**: `element` — CSS selector of the interaction target. `interaction_type` — `"pointer"` or `"keyboard"`.

FCP and TTFB are collected without attribution (basic handler).

Vitals are sent in the `vitals` array of the `events` payload, separate from `BrowserEvent` entries. Attributed to the page URL at collection time, with query params filtered through `breadcrumbs.query_params_allowlist` (same rules as network breadcrumbs). All params stripped by default.

Vital names: `web.vital.lcp`, `web.vital.cls`, `web.vital.inp`, `web.vital.fcp`, `web.vital.ttfb`. The backend ingests them into the generic metric system (not a dedicated table). Each vital is a gauge with dimensions for page URL path, browser, device type, and app version. Reuses existing metric storage, aggregation (p75, p95), alerting, and dashboards. Page URL path is the primary grouping dimension. When query params are present (via allowlist), they are stored as an additional dimension so the UI can show per-param breakdowns as children of the path aggregate.

### Error collection

Instrument `window.onerror` and `window.addEventListener("unhandledrejection")`. For each error:

1. Capture: message, filename, line, column, stack trace (as a string).
2. Attach current breadcrumbs (snapshot of the ring buffer).
3. Attach session context.
4. Send immediately (do not buffer).

Stack traces are sent as raw strings. Source map processing is server-side (future phase); the plugin does not do client-side source map application.

**Error filtering.** Errors matching any pattern in `ignoreErrors` are silently dropped before processing. Patterns are strings (substring match) or regular expressions. Common use: suppressing noise like `"ResizeObserver loop limit exceeded"` or `"Script error"`.

**beforeSend hook.** If provided, called with the error payload before sending. Can modify the payload (strip PII) or return `null` to drop. Runs after deduplication and filtering.

**Error deduplication.** Within one session, if the same error (same message + same stack top frame) fires more than 5 times in 10 seconds, the 6th+ are silently dropped. First 5 are sent normally. Prevents error storms from overwhelming ingestion.

### Session replay

Uses [@rrweb/record](https://github.com/rrweb-io/rrweb) (recorder-only, not the full rrweb bundle) to record the DOM as an event sequence.

**When to record.** Recording always starts immediately on `init()` because the fallback config has `replay.sample_rate: 1.0`. A per-session random is rolled once at init and stored. When the server config arrives, the random is compared against the real sample rate:
- `sessionRandom < replay.sample_rate`: sampled. Recording continues; chunks flush normally.
- Not sampled, `replay.error_replay = true`: recording continues but chunks flush only if an error occurs. Full replay from session start for error sessions without wasting bandwidth on error-free ones.
- Not sampled, `replay.error_replay = false`: buffer discarded, recording stops.

This ensures replay data is captured from the first DOM mutation regardless of config fetch time. The fallback sample rate of 1.0 drives this; no special "always record" logic needed.

**Privacy.** All text content masked by default. Input values, text nodes, and placeholder text replaced with `*`. Images replaced with a solid placeholder. `replay.mask_all_inputs` defaults to `true`. Relaxable per-element with `data-rrweb-unmasked`.

Additional masking via two config fields passed to rrweb at init:
- `replay.mask_selectors` — CSS selectors whose text content is masked with `*`. Applied on top of `mask_all_inputs`. Use for specific sensitive fields when `mask_all_inputs` is off.
- `replay.block_selectors` — CSS selectors whose elements are replaced entirely with a solid placeholder and never recorded. Use for payment iframes, SSN fields, or any widget you do not want recorded at all.

**Event batching.** rrweb events are batched every 5 seconds, or immediately on session end or error. Gzip compression via Web Worker is planned but not yet implemented.

**Recording chunks.** Long sessions produce multiple chunks. Each references the `session_id` and carries a `chunk_index`. The backend assembles them in order.

**Maximum recording duration.** Stops after `replay.max_duration_ms` (default 4 hours). Configurable server-side. Combined with the 30-minute inactivity timeout, most recordings are much shorter.

**Storage budget.** 50 MB in-memory cap for rrweb events. If a session exceeds it, older chunks are dropped and `replay_truncated: true` is set on the session.

### Event batching and transport

All non-error, non-replay events (breadcrumbs, vitals, session metadata) are batched into one payload, sent:
- On page hide (`visibilitychange` to hidden). web-vitals registers its own `visibilitychange` listeners during `initVitals()`, but it also defers final LCP / CLS / INP finalization through a `requestIdleCallback` / `setTimeout(0)` helper that runs after the SDK's flush. To avoid losing that last value, the SDK registers LCP / CLS / INP with `reportAllChanges: true` and keeps only the latest per `(name, page_url)` in the vitals array — the most recent known value always lands in the current flush.
- On tab close or navigation away (`pagehide`, when not persisted by bfcache).
- Every 30 seconds if the page is active.
- On explicit `flush()`.
- On SPA navigation (route change).

**Transport.** During a live session, events and replay chunks go via plain `fetch`. On `pagehide` / `visibilitychange → hidden`, a best-effort flush uses `navigator.sendBeacon`, which the browser delivers even as the page is unloading. Chromium caps both `sendBeacon` and `fetch({keepalive:true})` bodies at ~64 KB, so larger payloads are dropped on unload rather than attempted — the keepalive fallback Chrome would have rejected anyway. The lost payload is whatever accumulated since the last periodic flush: up to 5 s of replay events (often the trailing slice of a FullSnapshot-bearing chunk) or up to 30 s of breadcrumbs/vitals. Small payloads (the common case for events) fit under the cap and survive.

The ingestion key is always a query parameter: `POST /ingest/browser?key=<key>`. `Content-Type: text/plain` (body is JSON, but `text/plain` avoids CORS preflight, critical for cross-origin collection). The backend parses as JSON regardless of Content-Type.

**Retry.** Failed batches retry up to 3 times with exponential backoff and jitter. 5xx uses 1-second base (1s, 2s, 4s). 429 uses 5-second base (5s, 10s, 20s) to respect server capacity. Client errors (4xx other than 429) are not retried. If the browser goes offline mid-request, or all in-line retries are exhausted while the server is still failing, the payload goes into an in-memory retry queue. The queue drains on the next `online` event and on a 30 s periodic timer, so transient outages that don't trigger a network-state change (e.g. a server restart with an otherwise-healthy network) still recover. Payloads above the client-side cap of 10 MB — matching the server's `DefaultBodyLimit` — are dropped before sending.

**Breadcrumb flush semantics.** Each periodic flush and page-hide event drains the ring buffer — each breadcrumb is sent exactly once and removed. Error payloads snapshot the buffer (without draining) so they always include recent context. Avoids duplicate breadcrumbs across flushes while preserving error context.

### Distributed tracing

When `tracePropagationTargets` is configured, the plugin injects a [W3C `traceparent`](https://www.w3.org/TR/trace-context/) header into outgoing `fetch` and `XMLHttpRequest` requests whose URL matches any pattern. Connects frontend requests to backend traces.

Header format: `00-{traceId}-{spanId}-01` where `traceId` is a random 32-hex-char string and `spanId` a random 16-hex-char string. Backend APM (AppSignal, OpenTelemetry, any W3C-compatible tracer) reads the header and continues the trace, so the frontend click and backend handler appear as one connected trace.

Only requests matching `tracePropagationTargets` get the header. Prevents leaking trace context to third-party APIs. Glob syntax (same as `network_blocklist`).

### Bundle size

Two formats:

- **UMD** (`browser.umd.js`): single file, ~97 KB gzipped. Includes everything. Load via `<script>`.
- **ESM** (`esm/index.js`): ~13 KB gzipped core. `@rrweb/record` loads as a separate chunk (~82 KB gzipped) only when replay starts, so most page loads only pay 13 KB.

The replay recorder accounts for most of the bundle. It is the recorder-only subset of rrweb; no replay player included.

### Tracking consent

Three consent states for GDPR compliance. The customer's app is responsible for consent UI and calling `setConsent()`. The SDK never shows its own consent UI.

**States:**
- **`granted`** (default) — collect and send all data normally. Default for backwards compatibility: existing users without consent flows keep working.
- **`not-granted`** — stop all collection immediately. Buffered breadcrumbs cleared, queued payloads dropped, replay stops, no data sent, errors not captured.
- **`pending`** — collect normally (errors, breadcrumbs, vitals) but do not send. Transport payloads buffer in memory. On `granted`, the buffer flushes. On `not-granted`, the buffer drops and collection stops.

**Not persisted.** Consent state is not saved to localStorage or cookies. Must be set on each page load. The customer's consent management tool (CookieBot, OneTrust, custom) handles persistence and calls `setConsent()` with the stored choice on init.

**Initial consent.** Set via `trackingConsent` in `init()`, or call `setConsent()` any time after.

```js
// Option 1: set in init
AppsignalBrowser.init({
  key: "...",
  trackingConsent: "pending",
});

// Option 2: update later when user makes a choice
AppsignalBrowser.setConsent("granted");
```

### Privacy and PII

Conservative defaults:

- URL query parameters filtered through `breadcrumbs.query_params_allowlist`. Default empty, so all params are stripped. Only allowlisted names preserved.
- URLs matching `breadcrumbs.network_blocklist` never recorded.
- Network body capture off by default (`network_payloads.enabled = false`). When on, binary types always skipped and blocklisted URLs never captured.
- Console messages truncated at 200 chars.
- Replay masks all text and inputs by default. More masking via `replay.mask_selectors`, full blocking via `replay.block_selectors`.
- User fields (id, email, name) never collected unless `setUser()` is called.
- No cookies read or written beyond `anonymous_id` in `localStorage`.

## Framework plugins

Separate packages bridging framework-specific error handling into the core SDK via `captureError`. Small (<1 KB) with the core SDK as a peer dependency.

### React (`@appsignal/browser-react`)

An `ErrorBoundary` class component that catches React render errors via `componentDidCatch` and reports them through the core SDK's error pipeline. React does not expose error boundary functionality as hooks, so a class component is required.

**Props:**
- `captureError` (required) — the `captureError` function imported from `@appsignal/browser`. Passed as a prop to avoid coupling to module resolution (works for ESM and UMD).
- `fallback` — React node or render function `(error, reset) => ReactNode`. Shown when an error is caught.
- `onError` — optional callback `(error, componentStack) => void`. Called before sending to AppSignal.

**Error context:** Each captured error includes `componentName` (parsed from the component stack) and `componentStack` (the full React hierarchy at the time of the error) in the `context` field.

**`withErrorBoundary` HOC:** Wraps any component in an `ErrorBoundary`. Same props minus `children`.

```tsx
import { captureError } from "@appsignal/browser";
import { ErrorBoundary, withErrorBoundary } from "@appsignal/browser-react";

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
