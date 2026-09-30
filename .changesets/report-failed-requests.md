---
bump: minor
type: add
---

Report a failed request as an error, in the trace of the backend work it
caused. A request matching `tracePropagationTargets` sends a `traceparent`
header that names a span, and the backend's spans for that request point at it.
Until now the browser never sent that span, so those spans named a parent that
does not exist. A request that answers 5xx, or runs out of time, is now
reported as an `HTTPError` or a `TimeoutError` carrying that span's ids, so the
error and the backend work beneath it read as one trace.

Only a failure the backend can answer for is reported. A timeout means the
server took the request and may have traced it. A request that was refused,
undeliverable or blocked by an extension leaves no span to join, and the browser
reports every one of those the same way, so none of them is reported. A 4xx is
not a failure, and a deadline missed while the device is offline says nothing
about the backend. A rejection that the SDK reports this way is not reported a
second time when it reaches `window.onerror`.
