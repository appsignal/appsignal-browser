---
bump: minor
type: add
---

Add a React Native entry point, `@appsignal/browser/react-native`. It reports
caught and uncaught errors with the breadcrumbs, tags, user and route template
of the browser SDK. Network requests through `fetch` and `XMLHttpRequest` and
`console.warn` and `console.error` calls become breadcrumbs, and the app going
to the background or foreground is recorded through `AppState`. Uncaught errors
come from `ErrorUtils`, and React Native's own handler still runs after the
report.

Web vitals, click breadcrumbs, session streaming and persistent storage are not
part of this entry point. Every platform read in the SDK now goes through one
runtime adapter, so the browser build behaves as before.
