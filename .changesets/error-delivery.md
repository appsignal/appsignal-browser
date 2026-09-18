---
bump: patch
type: fix
---

Report errors from a tab that is not in front. `sendError` uses `sendBeacon`
when the tab is hidden, and it sent the body with the type `application/json`.
That type is not CORS-safelisted, so the beacon becomes a CORS request, and the
credentials mode of a beacon is always `include`. The preflight then gets
`Access-Control-Allow-Origin: *` and fails, the POST does not leave the browser,
and `sendBeacon` returns true. The beacon now uses `text/plain`, which the events
channel already used and which the endpoint reads raw. This applies to each
hidden tab, not only to page unload.

Keep the request that caused an error in that error. The network breadcrumb
waited up to 150ms for its resource timing, which put it after an error from the
response handler of the caller. The payload of that error is the only path to
the server when session streaming is off, so the request and its `trace_id` went
missing. The SDK now adds the breadcrumb immediately and adds the timing when
the PerformanceObserver supplies it. A failed request also keeps its own
`trace_id` now: it did not consume the id, and `pendingTraces` is a FIFO queue
with a URL key, so the next request to that URL took it. A request that the host
cancels reports as cancelled, not as a failure, for the same reason.

Count each payload size in bytes. `String.length` counts UTF-16 units, so a body
of 3-byte characters passed a check at three times the limit. The limit of 10 MB
for one payload, the budget of 32 MB for the queue, and the cap of 64 KB for the
beacon all used that count. A payload that the beacon cannot take now goes to
the retry queue, which a tab that is hidden but still alive can drain.
