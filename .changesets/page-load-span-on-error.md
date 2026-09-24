---
bump: minor
type: change
---

Only send the page load span for page loads that went wrong. Requests matching
`tracePropagationTargets` still carry a `traceparent` header, but the page load
span they point at is only sent once an error is reported, or a propagated
request fails or returns a 5xx. The trace for a failed request then shows the
page load, the failed request and the backend work beneath it as one tree.
Backend spans from page loads that went fine appear as top-level spans in their
trace, without a browser parent.
