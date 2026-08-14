---
bump: patch
type: fix
---

Report one page URL when a path has a trailing slash. `/checkout` and
`/checkout/` are now one page for the web vitals, the session context, the
error URL and the error action. This also applies to a hash route. A breadcrumb
and the session referrer keep the URL as it occurred.

The aggregation key changes with this release. A dashboard row for `/checkout/`
stops, and a new row for `/checkout` starts.
