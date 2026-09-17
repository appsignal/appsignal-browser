---
bump: patch
type: fix
---

Report errors whose breadcrumb data points back at itself. A host that passes a
framework controller or a DOM node to `addBreadcrumb` stored a circular
structure, and `JSON.stringify` in `sendError` then threw in whoever called
`captureError` — so the error never arrived.

Breadcrumb data and error context are now pruned before the payload is built:
back-references become `[Circular]`, depth and entry count are capped, `toJSON`
is honoured, and the SDK no longer holds the host's object graph. The
`beforeError` hook still receives the host's own object. Serialisation failures
in the transport drop the payload and log, rather than throw.
