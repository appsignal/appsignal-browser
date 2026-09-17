---
bump: patch
type: fix
---

Report a failed `init` as inactive instead of half-started. The initialised
flag went up before collection started, so a failure inside `startCollection`
left `captureError`, `setTags` and `clearTags` running against modules that
were never configured — every call raised a `TypeError`. The flag now goes up
last, a failed `init` rolls back what it built, and the error is logged rather
than thrown into the host page.
