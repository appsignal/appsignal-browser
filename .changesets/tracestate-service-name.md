---
bump: minor
type: change
---

Allow the `tracestate` header in the CORS configuration of a cross-origin
back end, next to `traceparent`, before you upgrade. The SDK now sends both
headers with each traced request. If the back end allows only `traceparent`,
the browser blocks the request.

The trace now shows the service name and the route of the front end
when the browser part of the trace is not sampled.
