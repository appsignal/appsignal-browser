---
bump: minor
type: change
---

Use one host-aware URL matcher for tracing targets and network blocklists.
Hosts match case insensitively and ignore trailing dots; paths remain case
sensitive. Host-only patterns match every path. Omitted ports match every port,
while explicit ports also recognize the protocol's default port. A path can
no longer satisfy a blocklist host pattern. Audit existing patterns when
upgrading: include ports to retain a narrow tracing target, and use a wildcard
host for a blocklist intended to match a path on every host.
