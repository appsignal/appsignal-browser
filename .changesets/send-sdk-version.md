---
bump: patch
type: add
---

Send the SDK version with every request, as the `version` query parameter next
to `api_key`. AppSignal records it on the app as the `browser` integration version, the way
it does for every other integration.
