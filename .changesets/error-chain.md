---
bump: minor
type: add
---

Send the request that an error followed.

An error now ships the last request before it as well as the page, with the
exception as an event on that request rather than on the page. The backend spans
of that request nest under it, so a trace reads from the request to the query
that failed.

The request span follows the OpenTelemetry conventions: a CLIENT span named by
its method, with `url.full`, `url.path` and an integer
`http.response.status_code`. The error payload carries the trace and the span it
belongs under, so the error and the spans that explain it read as one trace.
