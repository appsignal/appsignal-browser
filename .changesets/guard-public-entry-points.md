---
bump: patch
type: fix
---

Keep every public method from throwing into the host page. `init` was guarded,
and the other ten exports were not, so a failure inside the SDK surfaced in
whoever called it: a React render, a router effect, a catch block. Each export
now logs the failure and returns.

A `beforeError` hook that throws is now treated as passthrough, which is the
rule `beforeBreadcrumb` already followed. A bug in host code no longer drops
the error it was called for.

The wrapped exports keep their tree shaking: each one is marked as a pure
call, so a bundler still drops the methods an application does not import.
