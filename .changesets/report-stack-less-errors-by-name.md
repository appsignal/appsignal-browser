---
bump: patch
type: fix
---

Report stack-less errors by name instead of `{}`. A rejection carrying a
`DOMException` — an aborted fetch, a denied permission — keeps `name` and
`message` on the prototype and has no stack, so the duck-typed check rejected it
and `JSON.stringify` collapsed it to `"{}"`. Every such rejection then shared one
dedupe key and reached the dashboard with no message at all.

An error shape no longer has to carry a stack to be recognised, and a reason
that `JSON.stringify` cannot see falls back to its own string form and then its
class name.
