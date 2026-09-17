---
bump: patch
type: fix
---

Keep `init` from throwing where the random number generator refuses. Firefox
raises `OperationError` when `crypto.getRandomValues` fails, and `crypto` is
absent in some embedded webviews. The UUID helpers run during init, so the
throw escaped `init` and no telemetry was sent at all.

Randomness now falls back to `Math.random`. These IDs correlate a visitor, a
tab and a session; they carry no secret, so a weaker source costs collision
odds, not security.
