import type { SessionContext, UserContext } from "./types.js";
import { uuidv7 } from "uuidv7";

const SESSION_KEY = "appsignal_session_id";
const ANON_KEY = "appsignal_anonymous_id";
const LAST_ACTIVITY_KEY = "appsignal_last_activity";

let currentSessionId: string | null = null;
let currentUser: UserContext | null = null;
let inactivityTimeoutMs = 1_800_000;
let activityTimer: ReturnType<typeof setTimeout> | null = null;
let lastActivityMs = 0;

let activityTrackingStarted = false;

export function initSession(timeoutMs: number): void {
  inactivityTimeoutMs = timeoutMs;
  ensureAnonymousId();
  restoreOrCreateSession();
  restoreUser();
  if (!activityTrackingStarted) {
    startActivityTracking();
    activityTrackingStarted = true;
  }
}

function ensureAnonymousId(): void {
  if (!localStorage.getItem(ANON_KEY)) {
    localStorage.setItem(ANON_KEY, uuidv7());
  }
}

function restoreOrCreateSession(): void {
  const stored = localStorage.getItem(SESSION_KEY);
  lastActivityMs = Number(localStorage.getItem(LAST_ACTIVITY_KEY) || "0");
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
  localStorage.setItem(SESSION_KEY, currentSessionId);
  // Update timestamp directly — don't call touchActivity() which
  // checks for gaps and could recurse back into newSession().
  lastActivityMs = Date.now();
  localStorage.setItem(LAST_ACTIVITY_KEY, String(lastActivityMs));
  resetInactivityTimer();
}

export function getSessionId(): string {
  if (!currentSessionId) {
    restoreOrCreateSession();
  }
  // Check expiry before returning — ensures the first event after a
  // gap gets the new session, not the stale one.
  const now = Date.now();
  const elapsed = now - lastActivityMs;
  if (lastActivityMs > 0 && (elapsed >= inactivityTimeoutMs || elapsed < 0)) {
    newSession();
  }
  return currentSessionId!;
}

export function getAnonymousId(): string {
  return localStorage.getItem(ANON_KEY) || "";
}

const USER_KEY = "appsignal_user";

export function setUser(user: UserContext): void {
  currentUser = user;
  try { localStorage.setItem(USER_KEY, JSON.stringify(user)) } catch { /* ignore */ }
}

export function clearUser(): void {
  currentUser = null;
  localStorage.removeItem(USER_KEY);
}

function restoreUser(): void {
  if (currentUser) return;
  try {
    const stored = localStorage.getItem(USER_KEY);
    if (stored) currentUser = JSON.parse(stored);
  } catch { /* ignore */ }
}

/** End the current session. Clears session storage so next init creates a fresh session. */
export function endSession(): void {
  currentSessionId = null;
  currentUser = null;
  lastActivityMs = 0;
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(LAST_ACTIVITY_KEY);
  localStorage.removeItem(USER_KEY);
  if (activityTimer) {
    clearTimeout(activityTimer);
    activityTimer = null;
  }
}

export function touchActivity(): void {
  // Check if the session expired during a gap (e.g. laptop sleep).
  // Also handles clock skew: if time jumped backward, treat as expired
  // to avoid a session that can never expire.
  const now = Date.now();
  const elapsed = now - lastActivityMs;
  if (lastActivityMs > 0 && (elapsed >= inactivityTimeoutMs || elapsed < 0)) {
    newSession();
  }
  lastActivityMs = now;
  localStorage.setItem(LAST_ACTIVITY_KEY, String(now));
  resetInactivityTimer();
}

function resetInactivityTimer(): void {
  if (activityTimer) clearTimeout(activityTimer);
  activityTimer = setTimeout(() => {
    // Session expired due to inactivity — next activity starts a new one
    currentSessionId = null;
  }, inactivityTimeoutMs);
}

let activityHandler: (() => void) | null = null;
let visibilityHandler: (() => void) | null = null;
const ACTIVITY_EVENTS = ["click", "keydown", "scroll"];

function startActivityTracking(): void {
  activityHandler = () => touchActivity();
  for (const event of ACTIVITY_EVENTS) {
    document.addEventListener(event, activityHandler, { passive: true, capture: true });
  }

  visibilityHandler = () => {
    if (document.visibilityState === "hidden") {
      currentSessionId = null;
    } else if (document.visibilityState === "visible") {
      lastActivityMs = Number(localStorage.getItem(LAST_ACTIVITY_KEY) || "0");
      if (Date.now() - lastActivityMs >= inactivityTimeoutMs) {
        currentSessionId = null;
        localStorage.removeItem(SESSION_KEY);
      }
    }
  };
  document.addEventListener("visibilitychange", visibilityHandler);
}

export function destroySession(): void {
  endSession();
  if (activityHandler) {
    for (const event of ACTIVITY_EVENTS) {
      document.removeEventListener(event, activityHandler, { capture: true });
    }
    activityHandler = null;
  }
  if (visibilityHandler) {
    document.removeEventListener("visibilitychange", visibilityHandler);
    visibilityHandler = null;
  }
}

export function getSessionContext(): SessionContext {
  const ctx: SessionContext = {
    session_id: getSessionId(),
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
