---
bump: patch
type: fix
---

Keep `init` from throwing when the browser blocks site data. Reading the
`localStorage` global is itself a throwing operation — a `SecurityError` when
the origin has cookies or site data blocked, a `ReferenceError` where the global
is absent — and it happened outside the storage wrapper's guard, so it escaped
`init` and no telemetry was sent at all.

The area is now resolved inside the guard, and falls back to an in-memory store
so the anonymous, tab and session IDs stay coherent for the page. An area that
refuses one method, such as a write that exceeds the quota, moves to the same
store. These visitors start a new session on every page load.
