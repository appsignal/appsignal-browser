import { describe, it, expect, beforeEach, vi } from "vitest";
import { initSession, getSessionId, getAnonymousId, setUser, clearUser, getSessionContext, touchActivity, endSession } from "./session.js";

describe("session", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.useFakeTimers();
  });

  it("creates a session on init", () => {
    initSession(1800000);
    const id = getSessionId();
    expect(id).toMatch(/^[0-9a-f]{8}-/);
  });

  it("persists anonymous_id in localStorage", () => {
    initSession(1800000);
    const anonId = getAnonymousId();
    expect(anonId).toBeTruthy();
    expect(localStorage.getItem("appsignal_anonymous_id")).toBe(anonId);
  });

  it("restores session from localStorage within timeout", () => {
    initSession(1800000);
    const firstId = getSessionId();

    // Simulate re-init within timeout
    localStorage.setItem("appsignal_last_activity", String(Date.now()));
    initSession(1800000);
    expect(getSessionId()).toBe(firstId);
  });

  it("includes user context when set", () => {
    initSession(1800000);
    setUser({ id: "u1", email: "test@example.com", name: "Test" });
    const ctx = getSessionContext();
    expect(ctx.user_id).toBe("u1");
    expect(ctx.user_email).toBe("test@example.com");
    expect(ctx.user_name).toBe("Test");
  });

  it("clears user context without rotating the session", () => {
    initSession(1800000);
    const firstId = getSessionId();
    setUser({ id: "u1" });
    clearUser();
    const ctx = getSessionContext();
    expect(ctx.user_id).toBeUndefined();
    // Session identity is independent of user identity — clearUser must
    // not split a single visit across multiple session_ids.
    expect(getSessionId()).toBe(firstId);
  });

  it("populates session context fields", () => {
    initSession(1800000);
    const ctx = getSessionContext();
    expect(ctx.session_id).toBeTruthy();
    expect(ctx.anonymous_id).toBeTruthy();
    expect(ctx.user_agent).toBeTruthy();
    expect(ctx.language).toBeTruthy();
    expect(ctx.timezone).toBeTruthy();
    expect(typeof ctx.screen_width).toBe("number");
    expect(typeof ctx.viewport_width).toBe("number");
  });

  it("creates new session when activity gap exceeds timeout", () => {
    const timeout = 1800000; // 30 min
    initSession(timeout);
    const firstId = getSessionId();
    touchActivity();

    // Simulate laptop sleep: advance time past the timeout
    vi.advanceTimersByTime(timeout + 1000);

    // Next touch should detect the gap and create a new session
    touchActivity();
    expect(getSessionId()).not.toBe(firstId);
  });

  it("keeps session when activity gap is within timeout", () => {
    const timeout = 1800000;
    initSession(timeout);
    const firstId = getSessionId();
    touchActivity();

    vi.advanceTimersByTime(timeout - 1000);

    touchActivity();
    expect(getSessionId()).toBe(firstId);
  });

  it("restores user from localStorage on re-init", () => {
    initSession(1800000);
    setUser({ id: "u1", email: "test@example.com" });

    // Re-init within timeout (simulates page reload)
    initSession(1800000);
    const ctx = getSessionContext();
    expect(ctx.user_id).toBe("u1");
    expect(ctx.user_email).toBe("test@example.com");
  });

  it("endSession clears all session state", () => {
    initSession(1800000);
    const firstId = getSessionId();
    setUser({ id: "u1" });

    endSession();

    // Next getSessionId creates a fresh session
    const newId = getSessionId();
    expect(newId).not.toBe(firstId);
    const ctx = getSessionContext();
    expect(ctx.user_id).toBeUndefined();
  });

  it("persists session_id across simulated tab close and reopen", () => {
    // Headline behaviour of the localStorage move: a session survives tab
    // close/reopen (and is shared across tabs on the same origin), bounded
    // only by the inactivity timeout. Previously each tab minted its own
    // session_id via sessionStorage, fragmenting a single visit.
    initSession(1800000);
    const firstId = getSessionId();

    // Simulate tab close: localStorage persists, in-memory state is lost.
    // Clearing sessionStorage mirrors what the browser does on tab close —
    // confirms the session survives without sessionStorage.
    sessionStorage.clear();
    initSession(1800000);
    expect(getSessionId()).toBe(firstId);
    expect(localStorage.getItem("appsignal_session_id")).toBe(firstId);
  });
});
