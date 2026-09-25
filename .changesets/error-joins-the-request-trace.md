---
bump: minor
type: change
---

Put a browser error in the trace of the request it followed. A request matching
`tracePropagationTargets` sends a `traceparent` that names a span, and until now
the browser never sent that span, so the backend spans of the request had a
parent that does not exist. An error reported within ten seconds of the request
now takes that span as its own, and the trace shows the error with the backend
work of the request beneath it.

The request the error belongs to is a guess: the SDK cannot see which fetch a
thrown error came from, so it takes the most recent one. An error with no recent
propagated request, and every error from an app that sets no
`tracePropagationTargets`, keeps a trace of its own as before.
