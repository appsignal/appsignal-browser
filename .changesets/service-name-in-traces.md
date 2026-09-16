---
bump: minor
type: add
---

Add the `serviceName` option. It names this frontend as a service in traces.
The default is `Browser`. Set one name per frontend when one organization runs
several.

Every request that gets a `traceparent` header now also gets a `tracestate`
header with `appsignal=service:<name>`. A backend that keeps the trace state
lets AppSignal show the browser as the caller of its spans. Every error report
carries the same name as `service_name`.
