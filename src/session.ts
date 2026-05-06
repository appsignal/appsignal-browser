import type { SessionContext, UserContext } from "./types.js";
import { uuidv7 } from "uuidv7";
import { storage } from "./utils.js";
import { onVisibilityChange } from "./lifecycle.js";

const SESSION_KEY = "appsignal_session_id";
const ANON_KEY = "appsignal_anonymous_id";
const LAST_ACTIVITY_KEY = "appsignal_last_activity";
const TAB_KEY = "appsignal_tab_id";

let currentSessionId: string | null = null;
let currentUser: UserContext | null = null;
let inactivityTimeoutMs = 1_800_000;
let activityTimer: ReturnType<typeof setTimeout> | null = null;
let lastActivityMs = 0;

let activityTrackingStarted = false;

export function initSession(timeoutMs: number): void {
  inactivityTimeoutMs = timeoutMs;
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
}

export function getTabId(): string {
  return storage.getString(sessionStorage, TAB_KEY) || "";
}

function ensureAnonymousId(): void {
  if (!storage.getString(localStorage, ANON_KEY)) {
    storage.setString(localStorage, ANON_KEY, uuidv7());
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
  activityTrackingStarted = false;
}

export function getSessionContext(): SessionContext {
  const ctx: SessionContext = {
    session_id: getSessionId(),
    tab_id: getTabId(),
    anonymous_id: getAnonymousId(),
    page_url: location.href,
    referrer: document.referrer,
    user_agent: navigator.userAgent,
    screen_width: screen.width,
    screen_height: screen.height,
    viewport_width: window.innerWidth,
    viewport_height: window.innerHeight,
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };

  // Optional fields
  const nav = navigator as unknown as Record<string, unknown>;
  const conn = nav.connection as Record<string, unknown> | undefined;
  if (conn?.effectiveType) {
    ctx.connection_type = conn.effectiveType as string;
  }
  if (typeof nav.deviceMemory === "number") {
    ctx.device_memory = nav.deviceMemory as number;
  }

  // User context
  if (currentUser) {
    if (currentUser.id) ctx.user_id = currentUser.id;
    if (currentUser.email) ctx.user_email = currentUser.email;
    if (currentUser.name) ctx.user_name = currentUser.name;
  }

  return ctx;
}
