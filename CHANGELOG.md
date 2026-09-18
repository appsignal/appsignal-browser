# AppSignal for Browsers Changelog

## 1.0.0-beta.6

_Published on 2026-09-18._

### Fixed

- Report errors from a tab that is not in front. `sendError` uses `sendBeacon`
  when the tab is hidden, and it sent the body with the type `application/json`.
  That type is not CORS-safelisted, so the beacon becomes a CORS request, and the
  credentials mode of a beacon is always `include`. The preflight then gets
  `Access-Control-Allow-Origin: *` and fails, the POST does not leave the browser,
  and `sendBeacon` returns true. The beacon now uses `text/plain`, which the events
  channel already used and which the endpoint reads raw. This applies to each
  hidden tab, not only to page unload.

  Keep the request that caused an error in that error. The network breadcrumb
  waited up to 150ms for its resource timing, which put it after an error from the
  response handler of the caller. The payload of that error is the only path to
  the server when session streaming is off, so the request and its `trace_id` went
  missing. The SDK now adds the breadcrumb immediately and adds the timing when
  the PerformanceObserver supplies it. A failed request also keeps its own
  `trace_id` now: it did not consume the id, and `pendingTraces` is a FIFO queue
  with a URL key, so the next request to that URL took it. A request that the host
  cancels reports as cancelled, not as a failure, for the same reason.

  Count each payload size in bytes. `String.length` counts UTF-16 units, so a body
  of 3-byte characters passed a check at three times the limit. The limit of 10 MB
  for one payload, the budget of 32 MB for the queue, and the cap of 64 KB for the
  beacon all used that count. A payload that the beacon cannot take now goes to
  the retry queue, which a tab that is hidden but still alive can drain.

  (patch [b2c4c58](https://github.com/appsignal/appsignal-browser/commit/b2c4c58fd94633a34a08f4fe2428e2f58039083b))

## 1.0.0-beta.5

_Published on 2026-09-17._

### Fixed

- Keep every public method from throwing into the host page. `init` was guarded,
  and the other ten exports were not, so a failure inside the SDK surfaced in
  whoever called it: a React render, a router effect, a catch block. Each export
  now logs the failure and returns.

  A `beforeError` hook that throws is now treated as passthrough, which is the
  rule `beforeBreadcrumb` already followed. A bug in host code no longer drops
  the error it was called for.

  The wrapped exports keep their tree shaking: each one is marked as a pure
  call, so a bundler still drops the methods an application does not import.

  Session logout and SDK destruction now finish their cleanup even when the
  best-effort final flush fails. Teardown steps are isolated from one another,
  and diagnostic logging is itself guarded, so one hostile browser API or host
  console wrapper cannot leave collection half-active or reopen the exception
  boundary.

  (patch [dba7e6e](https://github.com/appsignal/appsignal-browser/commit/dba7e6e7ac252b9c10bfba0b53fdd117d036d156))
- Report a failed `init` as inactive instead of half-started. The initialised
  flag went up before collection started, so a failure inside `startCollection`
  left `captureError`, `setTags` and `clearTags` running against modules that
  were never configured — every call raised a `TypeError`. The flag now goes up
  last, a failed `init` rolls back what it built, and the error is logged rather
  than thrown into the host page.

  (patch [dba7e6e](https://github.com/appsignal/appsignal-browser/commit/dba7e6e7ac252b9c10bfba0b53fdd117d036d156))
- Report errors whose breadcrumb data points back at itself. A host that passes a
  framework controller or a DOM node to `addBreadcrumb` stored a circular
  structure, and `JSON.stringify` in `sendError` then threw in whoever called
  `captureError` — so the error never arrived.

  Breadcrumb data is now pruned after `beforeBreadcrumb`, so a hook cannot put a
  host object back: back-references become `[Circular]`, depth and entry count
  are capped, the whole walk stops after 1000 values, and `toJSON` is honoured. Error context gets the same treatment
  after `beforeError`, which releases the host's object graph and protects the
  `onErrorReported` subscribers. Both hooks still receive the host's own object.
  Serialisation failures in the transport drop the payload and log, rather than
  throw.

  (patch [dba7e6e](https://github.com/appsignal/appsignal-browser/commit/dba7e6e7ac252b9c10bfba0b53fdd117d036d156))
- Keep `init` from throwing where the random number generator refuses. Firefox
  raises `OperationError` when `crypto.getRandomValues` fails, and `crypto` is
  absent in some embedded webviews. The UUID helpers run during init, so the
  throw escaped `init` and no telemetry was sent at all.

  Randomness now falls back to `Math.random`. These IDs correlate a visitor, a
  tab and a session; they carry no secret, so a weaker source costs collision
  odds, not security.

  (patch [dba7e6e](https://github.com/appsignal/appsignal-browser/commit/dba7e6e7ac252b9c10bfba0b53fdd117d036d156))
- Keep `init` from throwing when the browser blocks site data. Reading the
  `localStorage` global is itself a throwing operation — a `SecurityError` when
  the origin has cookies or site data blocked, a `ReferenceError` where the global
  is absent — and it happened outside the storage wrapper's guard, so it escaped
  `init` and no telemetry was sent at all.

  The area is now resolved inside the guard, and a write that the area refuses,
  such as a write that exceeds the quota, is kept in an in-memory store. The
  anonymous, tab and session IDs stay coherent for the page. A key whose write
  was refused reads from that store until a later write to the area succeeds, so
  the tab stops seeing other tabs' updates to it. Every other key still reads
  from the real area, and deletes always reach it. Visitors with blocked site
  data start a new session on every page load.

  (patch [dba7e6e](https://github.com/appsignal/appsignal-browser/commit/dba7e6e7ac252b9c10bfba0b53fdd117d036d156))

## 1.0.0-beta.4

_Published on 2026-09-01._

### Fixed

- Report one page URL when a path has a trailing slash. `/checkout` and
  `/checkout/` are now one page for the web vitals, the session context, the
  error URL and the error action. This also applies to a hash route. A breadcrumb
  and the session referrer keep the URL as it occurred.

  The aggregation key changes with this release. A dashboard row for `/checkout/`
  stops, and a new row for `/checkout` starts.

  (patch [958331b](https://github.com/appsignal/appsignal-browser/commit/958331bef8c482908d1f134b56556f857c8803b6))

## 1.0.0-beta.3

_Published on 2026-08-06._

### Fixed

- Report stack-less errors by name instead of `{}`. A rejection carrying a
  `DOMException` — an aborted fetch, a denied permission — keeps `name` and
  `message` on the prototype and has no stack, so the duck-typed check rejected it
  and `JSON.stringify` collapsed it to `"{}"`. Every such rejection then shared one
  dedupe key and reached the dashboard with no message at all.

  An error shape no longer has to carry a stack to be recognised, and a reason
  that `JSON.stringify` cannot see falls back to its own string form and then its
  class name.

  (patch [de04140](https://github.com/appsignal/appsignal-browser/commit/de041405680b01336b2243afe2361d5545fef608))

## 1.0.0-beta.2

_Published on 2026-08-04._

### Fixed

- Fix `active: false` not being a complete no-op: importing the SDK patched
  `history.pushState` before `init()` ran. The patch now happens in `init()`, so an
  inactive SDK leaves the page untouched, and importing the SDK where there is no
  DOM no longer throws.

  (patch [df80265](https://github.com/appsignal/appsignal-browser/commit/df80265ec83309286be6cae9902bfb37dfb879b2))

## 1.0.0-beta.1

_Published on 2026-08-04._

### Added

- Add the AppSignal browser SDK. Collects frontend errors with stack traces, a
  breadcrumb trail leading up to each error, and web vitals, and posts them to
  the AppSignal ingest endpoint. Ships as an ES module and a UMD bundle, with an
  optional React adapter for error boundaries and route tracking.

  (major [a509f61](https://github.com/appsignal/appsignal-browser/commit/a509f61f51e370ed482416a7d0b018fe067764ff))
