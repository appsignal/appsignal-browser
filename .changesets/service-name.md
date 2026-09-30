---
bump: minor
type: add
---

Add the `serviceName` option. It names this frontend as a service in traces,
and every error report carries it. The default is `Browser`. Set one name per
frontend when one organization runs several.
