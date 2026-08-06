# @appsignal/browser

Standalone JavaScript SDK for frontend error tracking, breadcrumbs, and web vitals. Ships as an ES module and a UMD bundle.

## Interface

### Installation

```sh
npm install @appsignal/browser@beta
```

Call `init()` once, as early in the page lifecycle as you can — anything that throws before it runs is not captured. Gate on your build environment so dev/test/CI stay quiet, and pass a deploy identifier so errors and vitals correlate with releases:

```js
import { init } from "@appsignal/browser";

init({
  key: "your-public-ingestion-key",
  endpoint: "https://appsignal-endpoint.net",
  active: process.env.NODE_ENV === "production",
  appVersion: "2024-03-15.abc1234",
});
```

Without a bundler, the UMD build exposes the same API on an `AppsignalBrowser` global:

```html
<script src="https://cdn.jsdelivr.net/npm/@appsignal/browser@1.0.0-beta.2/dist/browser.umd.js"></script>
```

### Configuration

Everything past `key` and `endpoint` has a default. Full reference:

```ts
interface BrowserConfig {
  key: string;           // Public ingestion key (safe to expose in frontend code)
  endpoint?: string;     // https://appsignal-endpoint.net
  active?: boolean;      // default: true — false makes init() and every public
                         // method a no-op, so call sites need no guarding
  appVersion?: string;   // Release tag, commit SHA, or deploy ID

  // Drop with null, mutate to redact. Both run before any buffering,
  // and neither can be `async` — a Promise return is not awaited.
  beforeError?: (event: IncomingError) => IncomingError | null;
  beforeBreadcrumb?: (breadcrumb: Breadcrumb) => Breadcrumb | null;

  errors?: {
    enabled?: boolean;             // default: true
    sampleRate?: number;           // 0..1, default: 1.0
  };
  breadcrumbs?: {
    network?: boolean;             // default: true — fetch/XHR breadcrumbs
    console?: boolean;             // default: true — patches warn/error
    clicks?: boolean;              // default: true
    longTasks?: boolean;           // default: true
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

To change an option, redeploy with the new value. To stop collection for the rest of the page, call `destroy()` — it takes effect immediately but does not persist across a reload.

### API

```ts
// Called once, early in the page lifecycle
function init(config: BrowserConfig): void;

// Attach tags to every subsequent error payload, for filtering and searching.
// Merges with existing tags; an empty value drops a key; values are coerced to
// strings; at most 32 keys, oldest dropped first. Set once when the value is
// known — after authentication, say:
//   setTags({ plan: user.plan, org_id: user.orgId });
function setTags(tags: Record<string, unknown>): void;

// Remove all error tags. Typically on logout — tags outlive a reload otherwise.
function clearTags(): void;

// Tell the SDK which route template the user is on (e.g. "/users/:id").
// Errors group by it and web vitals attribute to it. Pass null to clear.
function setRouteTemplate(template: string | null): void;

// Add a manual breadcrumb
function addBreadcrumb(breadcrumb: {
  category: string;
  message: string;
  data?: Record<string, unknown>;
}): void;

// Report a caught error manually. Used by framework plugins and try/catch blocks.
function captureError(error: Error, context?: { componentName?: string; [key: string]: unknown }): void;

// Tear down the SDK: flushes remaining data and stops all collection for the
// rest of the page. Does not persist — the next init() collects again.
function destroy(): void;
```

## Behavior

### Error collection

Instrument `window.onerror` and `window.addEventListener("unhandledrejection")`. For each error:

1. Capture: message, filename, line, column, stack trace (as a string).
2. Attach current breadcrumbs (snapshot of the ring buffer).
3. Send immediately (do not buffer).

Stack traces are sent as raw strings.

**Cross-origin scripts.** When a script from another origin throws, the browser collapses it to an opaque `"Script error."` with no stack and no location, unless that script is served with `crossorigin="anonymous"` **and** an `Access-Control-Allow-Origin` header. The SDK drops these opaque, unsymbolicatable `"Script error."` entries rather than fill the stream with indistinguishable noise. To capture real errors from third-party/CDN-hosted scripts, add `crossorigin="anonymous"` to those `<script>` tags and ensure the host serves the matching CORS header.

**Non-`Error` rejections.** A `Promise.reject` whose reason isn't an `Error` (e.g. `reject({ code: 500 })`) is JSON-stringified so the detail survives in `message`, falling back to `String()` for primitives and non-serialisable values (circular refs, `BigInt`). Without this, object reasons would collapse to `"[object Object]"`.

**URL privacy.** The error payload's `environment.url` is scrubbed through `privacy.queryParamsAllowlist`, identically to every other captured URL — raw query params and OAuth fragments never ride along.

**Error grouping (`action`).** Errors group server-side by `action`, which is the `setRouteTemplate()` template (e.g. `/users/:id`) when set, otherwise the raw `location.pathname`. Declaring a template keeps ID-heavy routes from fragmenting into one error group per id — the same route key vitals attribution uses.

**Error tags.** The wire payload's `tags` map carries only what the host set via `setTags()` — arbitrary string key-values, coerced to strings (server-truncated to 256 bytes), capped at 32 keys. The SDK injects no identity of its own.

**beforeError hook.** If provided, called once per error at the entry point — *before* the error breadcrumb is added and *before* deduplication. Returning `null` drops the error completely; none of those side effects fire. Mutating fields on the returned `IncomingError` propagates into the eventual payload. This is the single hook for both noise suppression and field redaction:

```ts
beforeError: (e) => {
  if (/ResizeObserver/.test(e.message)) return null;        // drop noise
  e.message = e.message.replace(emailRe, "[redacted]");     // redact error fields
  e.stack   = e.stack?.replace(emailRe, "[redacted]");
  return e;
}
```

`beforeError` does *not* see `breadcrumbs` — those are attached after the hook approves. Redact breadcrumb-level data in `beforeBreadcrumb` instead (see *Privacy and PII*).

**Throttling.** The same error (same message and top stack frame) is sent at most 5 times per 10 seconds. Independently, total sends are capped at 100 per 10-second window across all distinct errors, which catches a page emitting many *different* errors. If errors go missing during a storm, this is why.

**Top-window scope (by design).** Instrumentation is attached to the top-level `window` only. Same-origin `<iframe>`s have their own `window` (and their own `fetch` / `XMLHttpRequest`), so errors thrown and network calls made *inside* a same-origin iframe are not captured. Cross-origin iframes are inaccessible regardless (same-origin policy). To monitor an embedded same-origin frame, initialize a separate SDK instance inside it.

### Breadcrumbs

Ordered timeline of what happened before an error, snapshotted into the error payload. Categories are toggled via `breadcrumbs.*` at `init()`.

Error payloads carry the **last 25 breadcrumbs**; older entries drop as newer ones arrive.

| Category | Recorded |
|---|---|
| `navigation` | The URL on init, then every `pushState` / `replaceState` / `popstate` / `hashchange`, with the previous and new URL. |
| `click` | A readable label for the clicked element — `data-breadcrumb` if present, otherwise its semantic type and text (`button "Submit"`, `link "Dashboard"`, `icon "Close"`). Capped at 50 chars. |
| `network` | Method, URL, status and duration for every `fetch` / XHR, plus the initial document load. Carries a `resource_timing` waterfall (dns, connect, ssl, ttfb, download, sizes, protocol) where the browser exposes one. |
| `console` | `console.warn` and `console.error`, first 200 chars. `console.log` is not patched. |
| `long_task` | Any main-thread block over 50 ms, with script attribution where the Long Animation Frame API is available. |
| `visibility` | Tab became hidden or visible. |
| `error` | Each captured error, so an earlier error appears in a later one's trail. |

URLs are scrubbed through `privacy.queryParamsAllowlist`, and requests matching `privacy.networkBlocklist` — or going to the AppSignal endpoint — are skipped entirely. Request and response **bodies are never captured**; attach what you need with `addBreadcrumb` instead.

A network breadcrumb reads `<METHOD> <url> <status>` whenever a response arrived, 404s and 500s included. The `(error)` suffix and `data.error: true` mean the request failed at transport level with no response at all.

Cross-origin requests report zero timings unless the server sends `Timing-Allow-Origin` — a browser restriction, not an SDK one.

### Web vitals

| Metric | Description | Core Web Vital | Per route? |
|--------|-------------|----------------|------------|
| LCP | Largest Contentful Paint — loading performance | Yes | Load only |
| CLS | Cumulative Layout Shift — visual stability | Yes | Yes |
| INP | Interaction to Next Paint — responsiveness | Yes | Yes |
| FCP | First Contentful Paint | No | Load only |
| TTFB | Time to First Byte | No | Load only |

LCP, FCP and TTFB come from [web-vitals](https://github.com/GoogleChrome/web-vitals). Browsers measure them once per page load and never re-fire them for SPA soft navigations, so they belong to the route the page loaded on. CLS and INP accrue over the page lifetime, so the SDK observes them itself and buckets them per route, resetting at each navigation — they need Chromium's `layout-shift` / `event-timing` entry types and aren't emitted where those are missing.

Call `setRouteTemplate()` on each router navigation so vitals aggregate by route shape (`/users/:id`) rather than raw URL.

Vitals flush at route and page boundaries, so a page killed by a crash or force-quit before one of those records nothing for that view. Hash routers segment only when the new hash looks like a route (`#/x` or `#!/x`) — an in-page anchor jump doesn't end a route.

### Event batching and transport

Errors send immediately on capture. Web vitals batch into an `events` payload and flush on page hide, on SPA navigation, and on an explicit `flush()`.

Live requests use `fetch`; unload flushes use `navigator.sendBeacon`. Failed batches retry with backoff, and payloads queue in memory while the browser is offline, draining when it reconnects.

The ingestion key rides as a query parameter: `POST /ingest/browser?api_key=<key>` — worth knowing if you maintain a CSP `connect-src` allowlist.

### Tracking consent

Collection starts when `init()` runs, so a GDPR-style consent gate is a matter of deferring the call until the user has granted consent. On revocation, `destroy()` stops collection immediately — but only for the current page. Store the decision yourself and gate `init()` on it, or the next page load starts collecting again.

### Privacy and PII

**`queryParamsAllowlist`** scrubs every captured URL — network and navigation breadcrumbs, `page_url`, `referrer`, each vital's `page_url`, and the error payload's `environment.url`. Param names are glob-matched, and the default `[]` strips all of them.

```
queryParamsAllowlist: ["utm_*", "page"]

https://example.com/search?q=alice@corp.com&page=2
  → https://example.com/search?page=2

https://example.com/dashboard?utm_source=email&token=abc
  → https://example.com/dashboard?utm_source=email

https://example.com/checkout#/payment
  → unchanged — hash routes and plain anchors are kept verbatim

https://example.com/callback#access_token=ey…&token_type=bearer
  → https://example.com/callback
```

That last case is the point of the fragment handling: an OAuth implicit-flow token never reaches us, while `#/route` apps keep working.

**`networkBlocklist`** is glob-matched against host + pathname, where `*` spans a single path segment and `**` spans any number. The request still happens — it just leaves no breadcrumb.

```
networkBlocklist: ["api.stripe.com/**", "*/auth/token", "example.com/users/*/card"]

  api.stripe.com/**          → every request to that host
  */auth/token               → /auth/token on any host
  example.com/users/*/card   → any single id in that position
```

Both `dom.*` selectors act on **click breadcrumbs only**. They do not reach error messages, network URLs or console output — scrub those with `queryParamsAllowlist` and the filtering hooks below.

**`dom.maskText`** replaces the captured text with `[masked]`. The breadcrumb still fires, so you keep the fact that a click happened.

```
maskText: [".order-total"]

click  button "Pay $42.00"   →   click  button "[masked]"
```

**`dom.blockElement`** drops the breadcrumb entirely — no record of the interaction at all. Use it for card forms, SSN fields, or anything that shouldn't surface.

```
blockElement: ["#card-form"]

click  input#cvc   →   (nothing recorded)
```

Both DOM selectors use `el.closest()`, so listing a wrapper covers every descendant.

Other defaults that round out the privacy posture:

- **HTTP bodies (request and response) are never captured.** No config exposes them.
- Console messages truncated at 200 chars.
- No cookies read or written. The SDK keeps a small set of `appsignal_*` keys in `localStorage` / `sessionStorage` for its own bookkeeping; none of them is a user identifier.

**Filtering hooks.** Two early-pipeline callbacks, both run before any buffering:

- `beforeError(event) → IncomingError | null` — fires once per error at the SDK's entry point, before the error breadcrumb is added and before dedupe. Mutate to redact `message`/`stack`/etc.; return `null` to drop (no breadcrumb pollution, no dedupe slot consumed). Sync only — a `Promise` return is detected, logged as a `console.error`, and the event is dropped.
- `beforeBreadcrumb(breadcrumb) → Breadcrumb | null` — fires once per breadcrumb at insertion (network, click, navigation, console, error, manual). Mutate to redact `message`/`data`; return `null` to drop.

## React (`@appsignal/browser/react`)

A subpath export of this package — nothing extra to install. `ErrorBoundary` catches React render errors via `componentDidCatch` and reports them through the core SDK's error pipeline. React does not expose error boundaries as hooks, so it is a class component.

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
