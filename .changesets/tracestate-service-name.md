---
bump: minor
type: add
---

When the SDK starts a trace for a request that matches
`tracePropagationTargets`, it also sends
`tracestate: appsignal=service:<serviceName>;action:<route>`. The route is the
template from `setRouteTemplate`, or the page path when no template is set. The
backend can then name the browser and its route as the caller of its spans. A
cross-origin backend must allow `tracestate` in `Access-Control-Allow-Headers`,
next to `traceparent`, or the browser blocks the request.
