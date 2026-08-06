# AppSignal for Browsers Changelog

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
