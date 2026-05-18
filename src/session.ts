import type { SessionContext, UserContext } from "./types.js";
import { storage, scrubUrl, uuidv4, uuidv7 } from "./utils.js";
import { onVisibilityChange } from "./lifecycle.js";

const SESSION_KEY = "appsignal_session_id";
const ANON_KEY = "appsignal_anonymous_id";
const LAST_ACTIVITY_KEY = "appsignal_last_activity";
const TAB_KEY = "appsignal_tab_id";
const TAB_CHANNEL = "appsignal_tab_collision";
// Per-SDK-instance random tag. Survives page reloads only if the same JS
// module evaluation persists (it doesn't — reloads start fresh), which is
// exactly what we want for collision detection: a duplicated tab and the
// original both have the same TAB_KEY in their copied sessionStorage but
// distinct in-memory tabInstanceTags, breaking the tie deterministically.
const tabInstanceTag = uuidv4();
let tabChannel: BroadcastChannel | null = null;

let currentSessionId: string | null = null;
let currentUser: UserContext | null = null;
let inactivityTimeoutMs = 1_800_000;
let activityTimer: ReturnType<typeof setTimeout> | null = null;
let lastActivityMs = 0;
let queryParamsAllowlist: string[] = [];

let activityTrackingStarted = false;

export function initSession(timeoutMs: number, allowlist: string[] = []): void {
  inactivityTimeoutMs = timeoutMs;
  queryParamsAllowlist = allowlist;
  ensureAnonymousId();
  ensureTabId();
  restoreOrCreateSession();
  restoreUser();
  if (!activityTrackingStarted) {
    startActivityTracking();
    activityTrackingStarted = true;
  }
}

function ensureTabId(): void {
  if (!storage.getString(sessionStorage, TAB_KEY)) {
    storage.setString(sessionStorage, TAB_KEY, uuidv7());
  }
  startTabCollisionWatch();
}

/** Chrome's "Duplicate Tab" copies sessionStorage to the new tab, so two
 * tabs end up with the same tab_id. Detect that via BroadcastChannel: each
 * tab announces (tab_id, tabInstanceTag); on receiving an announce that
 * matches our tab_id from a different tag, the tab with the lexically
 * larger tag regenerates. Both tabs reach the same conclusion since the
 * comparison is symmetric. */
function startTabCollisionWatch(): void {
  if (typeof BroadcastChannel === "undefined") return;
  if (tabChannel) return;
  try {
    tabChannel = new BroadcastChannel(TAB_CHANNEL);
    tabChannel.addEventListener("message", (e) => {
      const msg = e.data as { tabId?: string; tag?: string } | undefined;
      if (!msg?.tabId || !msg.tag) return;
      const myId = getTabId();
      if (msg.tabId !== myId || msg.tag === tabInstanceTag) return;
      if (tabInstanceTag > msg.tag) {
        // We lose the tiebreak — regenerate so the other tab keeps the id.
        const fresh = uuidv7();
        storage.setString(sessionStorage, TAB_KEY, fresh);
        // Re-announce with the new id so any third duplicate also resolves.
        tabChannel?.postMessage({ tabId: fresh, tag: tabInstanceTag });
      }
    });
    tabChannel.postMessage({ tabId: getTabId(), tag: tabInstanceTag });
  } catch {
    /* BroadcastChannel unsupported or restricted — silently skip */
  }
}

export function getTabId(): string {
  return storage.getString(sessionStorage, TAB_KEY) || "";
}

function ensureAnonymousId(): void {
  if (!storage.getString(localStorage, ANON_KEY)) {
    // v4 (not v7) — anonymous_id persists in localStorage and a v7's
    // 48-bit timestamp prefix would leak first-visit time across sessions.
    storage.setString(localStorage, ANON_KEY, uuidv4());
  }
}

function restoreOrCreateSession(): void {
  const stored = storage.getString(localStorage, SESSION_KEY);
  lastActivityMs = Number(storage.getString(localStorage, LAST_ACTIVITY_KEY) || "0");
  const now = Date.now();

  if (stored && now - lastActivityMs < inactivityTimeoutMs) {
    currentSessionId = stored;
  } else {
    newSession();
  }
  touchActivity();
}

function newSession(): void {
  currentSessionId = uuidv7();
  storage.setString(localStorage, SESSION_KEY, currentSessionId);
  // Don't call touchActivity() here — it could recurse back into newSession().
  lastActivityMs = Date.now();
  storage.setString(localStorage, LAST_ACTIVITY_KEY, String(lastActivityMs));
  resetInactivityTimer();
}

export function getSessionId(): string {
  if (!currentSessionId) {
    restoreOrCreateSession();
  }
  const stored = Number(storage.getString(localStorage, LAST_ACTIVITY_KEY) || "0");
  if (stored > lastActivityMs) lastActivityMs = stored;

  if (isInactive()) newSession();
  return currentSessionId!;
}

/** True when the inactivity window has elapsed since the last touch.
 * Returns true on backward clock skew (elapsed < 0) so a clock that drifted
 * backward still rotates the session rather than freezing it forever. */
function isInactive(): boolean {
  if (lastActivityMs <= 0) return false;
  const elapsed = Date.now() - lastActivityMs;
  return elapsed >= inactivityTimeoutMs || elapsed < 0;
}

export function getAnonymousId(): string {
  return storage.getString(localStorage, ANON_KEY) || "";
}

const USER_KEY = "appsignal_user";

export function setUser(user: UserContext): void {
  currentUser = user;
  storage.setJSON(localStorage, USER_KEY, user);
}

export function clearUser(): void {
  currentUser = null;
  storage.remove(localStorage, USER_KEY);
}

function restoreUser(): void {
  if (currentUser) return;
  const stored = storage.getJSON<UserContext>(localStorage, USER_KEY);
  if (stored) currentUser = stored;
}

/** End the current session. Clears session storage so next init creates a fresh session. */
export function endSession(): void {
  currentSessionId = null;
  currentUser = null;
  lastActivityMs = 0;
  storage.remove(localStorage, SESSION_KEY);
  storage.remove(localStorage, LAST_ACTIVITY_KEY);
  storage.remove(localStorage, USER_KEY);
  if (activityTimer) {
    clearTimeout(activityTimer);
    activityTimer = null;
  }
}

export function touchActivity(): void {
  if (isInactive()) newSession();
  const now = Date.now();
  lastActivityMs = now;
  storage.setString(localStorage, LAST_ACTIVITY_KEY, String(now));
  resetInactivityTimer();
}

function resetInactivityTimer(): void {
  if (activityTimer) clearTimeout(activityTimer);
  activityTimer = setTimeout(() => {
    currentSessionId = null;
  }, inactivityTimeoutMs);
}

let activityHandler: (() => void) | null = null;
let unsubVisibility: (() => void) | null = null;
let storageHandler: ((e: StorageEvent) => void) | null = null;
const ACTIVITY_EVENTS = ["click", "keydown", "scroll"];

function startActivityTracking(): void {
  activityHandler = () => touchActivity();
  for (const event of ACTIVITY_EVENTS) {
    document.addEventListener(event, activityHandler, {
      passive: true,
      capture: true,
    });
  }

  unsubVisibility = onVisibilityChange((state) => {
    if (state === "hidden") {
      currentSessionId = null;
    } else if (state === "visible") {
      lastActivityMs = Number(storage.getString(localStorage, LAST_ACTIVITY_KEY) || "0");
      if (Date.now() - lastActivityMs >= inactivityTimeoutMs) {
        currentSessionId = null;
        storage.remove(localStorage, SESSION_KEY);
      }
    }
  });

  storageHandler = (e: StorageEvent) => {
    if (e.key === SESSION_KEY) {
      // Adopt the new value; getSessionId() mints a fresh one if null.
      currentSessionId = e.newValue;
    } else if (e.key === LAST_ACTIVITY_KEY) {
      const v = Number(e.newValue || "0");
      if (v > lastActivityMs) lastActivityMs = v;
    } else if (e.key === USER_KEY) {
      try {
        currentUser = e.newValue ? JSON.parse(e.newValue) : null;
      } catch {
        /* ignore */
      }
    }
  };
  window.addEventListener("storage", storageHandler);
}

export function destroySession(): void {
  endSession();
  if (activityHandler) {
    for (const event of ACTIVITY_EVENTS) {
      document.removeEventListener(event, activityHandler, { capture: true });
    }
    activityHandler = null;
  }
  if (unsubVisibility) {
    unsubVisibility();
    unsubVisibility = null;
  }
  if (storageHandler) {
    window.removeEventListener("storage", storageHandler);
    storageHandler = null;
  }
  if (tabChannel) {
    tabChannel.close();
    tabChannel = null;
  }
  activityTrackingStarted = false;
  staticContextFields = null;
}

// Stable for the lifetime of a page; cached lazily on first read so we don't
// recompute Intl.DateTimeFormat on every payload (errors, event flushes,
// replay chunks). Reset on destroySession so a re-init picks up changes
// (test reloads, jsdom env mutations).
interface StaticContextFields {
  referrer: string;
  user_agent: string;
  screen_width: number;
  screen_height: number;
  language: string;
  timezone: string;
  device_memory?: number;
}
let staticContextFields: StaticContextFields | null = null;

function getStaticContextFields(): StaticContextFields {
  if (staticContextFields) return staticContextFields;
  const fields: StaticContextFields = {
    referrer: document.referrer,
    user_agent: navigator.userAgent,
    screen_width: screen.width,
    screen_height: screen.height,
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  const nav = navigator as unknown as Record<string, unknown>;
  if (typeof nav.deviceMemory === "number") {
    fields.device_memory = nav.deviceMemory as number;
  }
  staticContextFields = fields;
  return fields;
}

/** Update the query-param allowlist after the server config arrives. The
 * cached `staticContextFields.referrer` stays raw; scrubUrl runs on each read. */
export function updateSessionConfig(allowlist: string[]): void {
  queryParamsAllowlist = allowlist;
}

export function getSessionContext(): SessionContext {
  const stat = getStaticContextFields();
  const ctx: SessionContext = {
    session_id: getSessionId(),
    tab_id: getTabId(),
    anonymous_id: getAnonymousId(),
    page_url: scrubUrl(location.href, queryParamsAllowlist),
    referrer: scrubUrl(stat.referrer, queryParamsAllowlist),
    user_agent: stat.user_agent,
    screen_width: stat.screen_width,
    screen_height: stat.screen_height,
    // Viewport changes on resize and orientation change; read live.
    viewport_width: window.innerWidth,
    viewport_height: window.innerHeight,
    language: stat.language,
    timezone: stat.timezone,
  };
  if (stat.device_memory !== undefined) ctx.device_memory = stat.device_memory;

  // connection.effectiveType can shift mid-session (4G ↔ wifi); read live.
  const nav = navigator as unknown as Record<string, unknown>;
  const conn = nav.connection as Record<string, unknown> | undefined;
  if (conn?.effectiveType) {
    ctx.connection_type = conn.effectiveType as string;
  }

  // User context
  if (currentUser) {
    if (currentUser.id) ctx.user_id = currentUser.id;
    if (currentUser.email) ctx.user_email = currentUser.email;
    if (currentUser.name) ctx.user_name = currentUser.name;
  }

  return ctx;
}
