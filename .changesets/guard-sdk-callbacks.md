---
bump: patch
type: fix
---

Keep the SDK's own failures out of the customer's error stream. A throw inside
a callback the SDK registers with the browser, an event listener, a
`PerformanceObserver`, a timer, reached `window.onerror`, where the SDK's error
handler reported it as an error of the application.

`isOwnError` could not recognise it. It matches `@appsignal/browser` against the
stack, which holds for the CDN build, but a bundler renames the file to
`/assets/index-a1b2c3.js` and minifies the frames. That is the normal npm path,
so most customers paid for SDK bugs with their own quota.

Each registration site now catches, and the failure goes to the console.
