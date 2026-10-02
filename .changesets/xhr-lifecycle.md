---
bump: patch
type: fix
---

Give each XHR request its own preparation and completion state. Preserve
headers after rejected sends and report timeouts correctly across nested
synchronous retries and host cleanup.
