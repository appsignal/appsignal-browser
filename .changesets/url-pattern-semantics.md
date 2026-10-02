---
bump: minor
type: change
---

Share host-aware URL matching between tracing and network blocklists. Hosts
are case insensitive and ignore trailing dots; paths are case sensitive.
Host-only patterns cover every path, omitted ports cover every port, and
explicit default ports work. Paths cannot satisfy host patterns.

Audit existing patterns: add ports to narrow tracing targets, and use wildcard
hosts for blocklists intended to match paths on every host.
