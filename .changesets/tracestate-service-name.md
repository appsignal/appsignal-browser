---
bump: minor
type: change
---

Send the `tracestate` header with each traced request, so the trace shows the
front end's service name and route; allow it in your CORS configuration next
to `traceparent`.
