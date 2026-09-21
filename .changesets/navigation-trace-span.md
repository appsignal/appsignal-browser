---
bump: minor
type: add
---

Add the `tracing` option. It sends one span for the navigation an error
happened in, as OTLP over HTTP, so the backend spans of a page have a parent
that exists and the trace says which page asked for them. Set `endpoint`,
`appName` and `environment` to turn it on. The SDK posts to
`<endpoint>/v1/traces`, so any receiver that speaks OTLP can take it.

Every request of a page now shares one trace, where before each request made a
trace of its own. A route change starts the next one, so a single-page app does
not build one trace that never ends. The span carries the route as its action,
the error as an `exception` event, and the request before the error with the
time between the two, because a request that ends long before an error is
unlikely to have caused it.
