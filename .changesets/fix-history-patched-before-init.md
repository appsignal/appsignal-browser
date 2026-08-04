---
bump: patch
type: fix
---

Fix `active: false` not being a complete no-op: importing the SDK patched
`history.pushState` before `init()` ran. The patch now happens in `init()`, so an
inactive SDK leaves the page untouched, and importing the SDK where there is no
DOM no longer throws.
