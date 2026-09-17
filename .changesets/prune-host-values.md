---
bump: patch
type: fix
---

Report errors whose breadcrumb data points back at itself. A host that passes a
framework controller or a DOM node to `addBreadcrumb` stored a circular
structure, and `JSON.stringify` in `sendError` then threw in whoever called
`captureError` — so the error never arrived.

Breadcrumb data is now pruned after `beforeBreadcrumb`, so a hook cannot put a
host object back: back-references become `[Circular]`, depth and entry count
are capped, the whole walk stops after 1000 values, and `toJSON` is honoured. Error context gets the same treatment
after `beforeError`, which releases the host's object graph and protects the
`onErrorReported` subscribers. Both hooks still receive the host's own object.
Serialisation failures in the transport drop the payload and log, rather than
throw.
