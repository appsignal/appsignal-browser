---
bump: minor
type: add
---

Add the `tracing` option. It sends one span for each navigation, as OTLP over
HTTP, so the backend spans of a page have a parent that exists and the trace
says which page asked for them. Set `endpoint`, `appName` and `environment` to
turn it on. The SDK posts to `<endpoint>/v1/traces`, so any receiver that
speaks OTLP can take it.

A route change starts the next trace, so a single-page app does not build one
trace that never ends.

A navigation that throws sends one span, with the route as its action and every
error of that navigation as an `exception` event. A navigation that goes well
sends nothing, because the backend already describes each request it served.
The span leaves at the next flush after the first error, or when the navigation
ends, and it leaves once.
