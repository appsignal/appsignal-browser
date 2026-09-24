---
bump: minor
type: change
---

Scope a trace to one interaction, and name the action that led to an error.

A trace covers the page up to the first thing the person does, then one
interaction each. A `pointerdown` or a `keydown` ends the open trace, and the
next request starts a new one, so the page's own loading is not in the trace an
error belongs to. An interaction that asks for nothing starts no trace.

An error now also ships the last thing the person did before it. The request
hangs off that action, so a trace reads from the click to the query that failed.
