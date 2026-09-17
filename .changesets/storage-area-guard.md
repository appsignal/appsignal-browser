---
bump: patch
type: fix
---

Keep `init` from throwing when the browser blocks site data. Reading the
`localStorage` global is itself a throwing operation — a `SecurityError` when
the origin has cookies or site data blocked, a `ReferenceError` where the global
is absent — and it happened outside the storage wrapper's guard, so it escaped
`init` and no telemetry was sent at all.

The area is now resolved inside the guard, and a write that the area refuses,
such as a write that exceeds the quota, is kept in an in-memory store. The
anonymous, tab and session IDs stay coherent for the page. A key whose write
was refused reads from that store until a later write to the area succeeds, so
the tab stops seeing other tabs' updates to it. Every other key still reads
from the real area, and deletes always reach it. Visitors with blocked site
data start a new session on every page load.
