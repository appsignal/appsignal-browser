---
bump: patch
type: fix
---

Keep the SDK's own posts out of the network hook. A propagation target that
covers the ingest host no longer adds a `traceparent` to them, and they skip
any `fetch` wrapper that the host installs after `init`.

A network breadcrumb now carries the trace id of its own request. Two requests
to one URL that answered out of order could swap their ids before.
