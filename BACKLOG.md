# Backlog

Open observations and refactors we've chosen not to do *yet*. Each entry should be specific enough that a future PR can quote it verbatim. If an item gets done, remove it; if it gets filed as a GitHub issue, link the issue and remove from here.

---

## Bundle module-level state across collectors

**Where**: `src/session.ts`, `src/breadcrumbs.ts`, `src/errors.ts`, `src/transport.ts`, `src/replay.ts`, `src/tracing.ts`.

Every collector module uses the same shape: a fistful of module-level `let` variables populated by `initX()` and read from later by handlers and helpers. `session.ts` is the most prominent — `currentSessionId`, `currentUser`, `inactivityTimeoutMs`, `activityTimer`, `lastActivityMs`, `activityTrackingStarted` (plus a few more) all sit at module scope and are mutated freely from `restoreOrCreateSession`, `newSession`, `touchActivity`, `isInactive`, and `getSessionId`.

The smell: functions like `isInactive()` read the world implicitly, which makes them harder to test (set five globals first) and harder to reason about (which call site set `lastActivityMs` last?). Bundling related state into a single state object — and ideally making helpers like `isInactive(state, now)` pure — would localise the data flow.

**Why we deferred**: the pattern is uniform across the SDK. Refactoring just `session.ts` would make it the odd one out and force a context-switch when reading neighbouring modules. The real win is making the helpers *pure*, not just renaming `lastActivityMs` to `state.lastActivityMs`, and that's the expensive version of the refactor.

**Trigger to revisit**: either (a) the next time `session.ts` accumulates enough new state that the smell forces our hand, or (b) we decide to do a cross-module consistency pass and tackle all six files in one bounded job.
