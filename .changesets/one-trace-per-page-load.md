---
bump: minor
type: change
---

Group everything a page load does into one trace. When `tracePropagationTargets`
is configured, every request from a page load now carries the same `traceparent`
header, where before each request got its own. All the backend work one page
triggered therefore lands in a single trace instead of being scattered across
one trace per request. Any error from that page load is sent with the same trace
and span, so the error and the backend requests around it belong to the same
trace too. The IDs start over on every route change, so a long-lived
single-page app does not build up one ever-growing trace.

Errors from one page view are also grouped together more consistently. They all
now report the same action. Before, an error thrown before your router declared
its route template reported the raw path while a later error on the same page
reported the template, which split them into two incidents.
