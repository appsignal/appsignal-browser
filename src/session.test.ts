import { describe, it, expect, beforeEach, vi } from "vitest";
import { initSession, getSessionId, getTabId, getAnonymousId, setUser, clearUser, setTags, clearTags, getTags, getSessionContext, touchActivity, endSession, destroySession } from "./session.js";

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

  describe("error tags (setTags)", () => {
    it("stores tags and returns them via getTags", () => {
      initSession(1800000);
      setTags({ plan: "pro", org_id: "acme" });
      expect(getTags()).toEqual({ plan: "pro", org_id: "acme" });
    });

    it("merges successive calls rather than replacing", () => {
      initSession(1800000);
      setTags({ plan: "pro" });
      setTags({ org_id: "acme" });
      expect(getTags()).toEqual({ plan: "pro", org_id: "acme" });
    });

    it("coerces values to strings and drops empty/nullish keys", () => {
      initSession(1800000);
      setTags({
        plan: 42,
        active: true,
        blank: "",
        missing: null,
        absent: undefined,
      } as Record<string, unknown>);
      expect(getTags()).toEqual({ plan: "42", active: "true" });
    });

    it("removes a key when set to an empty value", () => {
      initSession(1800000);
      setTags({ plan: "pro", org_id: "acme" });
      setTags({ plan: "" });
      expect(getTags()).toEqual({ org_id: "acme" });
    });

    it("caps the number of tags to guard against high cardinality", () => {
      initSession(1800000);
      const many: Record<string, string> = {};
      for (let i = 0; i < 50; i++) many[`k${i}`] = `v${i}`;
      setTags(many);
      expect(Object.keys(getTags())).toHaveLength(32);
    });

    it("keeps a just-set tag when over the cap, dropping older ones", () => {
      initSession(1800000);
      const many: Record<string, string> = {};
      for (let i = 0; i < 32; i++) many[`k${i}`] = `v${i}`;
      setTags(many); // at the cap
      setTags({ release: "v2" }); // critical new tag must survive
      const tags = getTags();
      expect(Object.keys(tags)).toHaveLength(32);
      expect(tags.release).toBe("v2");
      expect(tags.k0).toBeUndefined(); // oldest dropped instead
    });

    it("clearTags empties the set without rotating the session", () => {
      initSession(1800000);
      const firstId = getSessionId();
      setTags({ plan: "pro" });
      clearTags();
      expect(getTags()).toEqual({});
      expect(getSessionId()).toBe(firstId);
    });

    it("does not leak tags into the session context", () => {
      initSession(1800000);
      setTags({ plan: "pro" });
      // Tags are error-only; SessionContext carries identity, not tags.
      expect(getSessionContext()).not.toHaveProperty("plan");
    });

    it("ignores a corrupted (non-object) tags value in localStorage", () => {
      // A foreign script or stale SDK version could leave a non-object here;
      // it must not flow onto the error wire.
      localStorage.setItem("appsignal_tags", JSON.stringify(["not", "an", "object"]));
      initSession(1800000);
      expect(getTags()).toEqual({});
    });

    it("restores and re-coerces a valid tags object from localStorage", () => {
      localStorage.setItem("appsignal_tags", JSON.stringify({ plan: "pro", n: 7 }));
      initSession(1800000);
      expect(getTags()).toEqual({ plan: "pro", n: "7" });
    });
  });

  it("caches stable fields across getSessionContext calls", () => {
    // user_agent / language / timezone / screen dimensions don't change
    // for the lifetime of a page. Reading them on every payload (errors,
    // event flushes, replay chunks) needlessly walks into platform APIs
    // — Intl.DateTimeFormat in particular is non-trivial.
    initSession(1800000);

    // Prime the cache.
    getSessionContext();

    const intlSpy = vi.spyOn(Intl, "DateTimeFormat");
    getSessionContext();
    getSessionContext();
    getSessionContext();

    expect(intlSpy).not.toHaveBeenCalled();
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

  describe("tab_id", () => {
    it("mints a tab_id on init and exposes it via getTabId", () => {
      initSession(1800000);
      const tabId = getTabId();
      expect(tabId).toMatch(/^[0-9a-f]{8}-/);
      // Persisted in sessionStorage so it survives in-tab reloads but not
      // tab close. Confirms the per-tab scoping rather than per-session.
      expect(sessionStorage.getItem("appsignal_tab_id")).toBe(tabId);
    });

    it("returns the same tab_id across re-init (simulated reload in same tab)", () => {
      initSession(1800000);
      const first = getTabId();
      // Second init in the same tab — sessionStorage persists across reloads.
      initSession(1800000);
      expect(getTabId()).toBe(first);
    });

    it("includes tab_id in session context", () => {
      initSession(1800000);
      const ctx = getSessionContext();
      expect(ctx.tab_id).toBeTruthy();
      expect(ctx.tab_id).toBe(getTabId());
    });

    it("mints a different tab_id when sessionStorage is cleared (simulated new tab)", () => {
      // sessionStorage is per-tab; clearing it imitates opening a fresh
      // tab on the same origin, which gets its own tab_id while sharing
      // session_id via localStorage.
      initSession(1800000);
      const firstTab = getTabId();
      const sessionId = getSessionId();

      sessionStorage.clear();
      initSession(1800000);

      expect(getTabId()).not.toBe(firstTab);
      // Same session_id (via localStorage) — different tab_id.
      expect(getSessionId()).toBe(sessionId);
    });

    it("regenerates tab_id when another tab announces the same id with a smaller tag", async () => {
      // Chrome's Duplicate Tab copies sessionStorage, so two live tabs end
      // up with the same persisted tab_id. The BroadcastChannel collision
      // protocol resolves this: the tab with the lexicographically larger
      // in-memory tag regenerates.
      const listeners: Array<(ev: MessageEvent) => void> = [];
      const posted: Array<{ tabId?: string; tag?: string }> = [];
      const FakeBC = class {
        addEventListener(_: string, fn: (ev: MessageEvent) => void) { listeners.push(fn); }
        removeEventListener(_: string, fn: (ev: MessageEvent) => void) {
          const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1);
        }
        postMessage(data: unknown) { posted.push(data as { tabId?: string; tag?: string }); }
        close() {}
      };
      vi.stubGlobal("BroadcastChannel", FakeBC);
      destroySession(); // reset module-level tabChannel from any prior test

      initSession(1800000);
      const initialTabId = getTabId();
      const myAnnounce = posted.find((m) => m.tabId === initialTabId);
      expect(myAnnounce).toBeTruthy();
      const myTag = myAnnounce!.tag!;

      // Simulate another tab announcing the same id with a smaller tag —
      // we should regenerate.
      const smallerTag = "0".repeat(myTag.length);
      expect(smallerTag < myTag).toBe(true);
      for (const fn of listeners) {
        fn({ data: { tabId: initialTabId, tag: smallerTag } } as MessageEvent);
      }
      expect(getTabId()).not.toBe(initialTabId);

      vi.unstubAllGlobals();
    });

    it("keeps tab_id when another tab announces with a larger tag", () => {
      const listeners: Array<(ev: MessageEvent) => void> = [];
      const posted: Array<{ tabId?: string; tag?: string }> = [];
      const FakeBC = class {
        addEventListener(_: string, fn: (ev: MessageEvent) => void) { listeners.push(fn); }
        removeEventListener(_: string, fn: (ev: MessageEvent) => void) {
          const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1);
        }
        postMessage(data: unknown) { posted.push(data as { tabId?: string; tag?: string }); }
        close() {}
      };
      vi.stubGlobal("BroadcastChannel", FakeBC);
      destroySession(); // reset module-level tabChannel from any prior test

      initSession(1800000);
      const initialTabId = getTabId();

      // Larger tag than any uuid — we keep our id.
      const largerTag = "z".repeat(36);
      for (const fn of listeners) {
        fn({ data: { tabId: initialTabId, tag: largerTag } } as MessageEvent);
      }
      expect(getTabId()).toBe(initialTabId);

      vi.unstubAllGlobals();
    });
  });

  describe("cross-tab sync via storage events", () => {
    it("adopts a session_id rotated by another tab", () => {
      initSession(1800000);
      const original = getSessionId();

      // Another tab rotated the session in localStorage and the storage
      // event fires in this tab. The handler must update our in-memory
      // currentSessionId so the next emit uses the new id.
      const next = "11111111-1111-1111-1111-111111111111";
      window.dispatchEvent(new StorageEvent("storage", {
        key: "appsignal_session_id",
        newValue: next,
        oldValue: original,
        storageArea: localStorage,
      }));

      expect(getSessionId()).toBe(next);
    });

    it("adopts last_activity bumped by another tab so visible-but-idle tab does not rotate", () => {
      // Regression for visible-tab drift: tab A is visible but idle,
      // tab B is active. Without sync, tab A's in-memory lastActivityMs
      // ages out and A rotates while B keeps using the original session.
      const timeout = 1800000;
      initSession(timeout);
      const original = getSessionId();

      // Simulate 25 minutes passing — close to but under the timeout.
      vi.advanceTimersByTime(25 * 60 * 1000);

      // Another tab's touchActivity wrote a fresh timestamp to localStorage
      // and the browser fires a storage event in this tab. Real cross-tab
      // behaviour requires both: localStorage carries the truth, the event
      // wakes other tabs up to it.
      const fresh = Date.now();
      localStorage.setItem("appsignal_last_activity", String(fresh));
      window.dispatchEvent(new StorageEvent("storage", {
        key: "appsignal_last_activity",
        newValue: String(fresh),
        storageArea: localStorage,
      }));

      // Another 20 minutes pass (45 since init). Without the sync, the
      // 30-min timer would have fired by now and rotated. With sync, the
      // cross-tab activity at t=25 keeps us under the 30-min threshold.
      vi.advanceTimersByTime(20 * 60 * 1000);

      expect(getSessionId()).toBe(original);
    });

    it("clears user when another tab clears it", () => {
      initSession(1800000);
      setUser({ id: "u1", email: "test@test.com" });
      expect(getSessionContext().user_id).toBe("u1");

      window.dispatchEvent(new StorageEvent("storage", {
        key: "appsignal_user",
        newValue: null,
        storageArea: localStorage,
      }));

      expect(getSessionContext().user_id).toBeUndefined();
    });
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
