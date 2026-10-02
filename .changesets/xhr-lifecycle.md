---
bump: patch
type: fix
---

Track XMLHttpRequest preparation, sending, and terminal events in per-object
state. Preserve applied headers when native send rejects and retain each
completed request's terminal marker so nested synchronous retries cannot
consume an earlier request's timeout. Capture status and end time before
host cleanup resets the native object, and settle each record exactly once.
