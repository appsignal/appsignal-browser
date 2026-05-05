import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { storage } from "./utils.js";

describe("storage helper", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("happy path", () => {
    it("getString / setString round-trip", () => {
      storage.setString(localStorage, "k", "v");
      expect(storage.getString(localStorage, "k")).toBe("v");
    });

    it("getString returns null for missing keys", () => {
      expect(storage.getString(localStorage, "missing")).toBeNull();
    });

    it("remove deletes a key", () => {
      storage.setString(localStorage, "k", "v");
      storage.remove(localStorage, "k");
      expect(storage.getString(localStorage, "k")).toBeNull();
    });

    it("getJSON / setJSON round-trip preserves shape", () => {
      const value = { id: "u1", nested: { count: 3 }, list: [1, 2] };
      storage.setJSON(localStorage, "k", value);
      expect(storage.getJSON(localStorage, "k")).toEqual(value);
    });

    it("getJSON returns null for missing keys", () => {
      expect(storage.getJSON(localStorage, "missing")).toBeNull();
    });

    it("getJSON returns null for malformed JSON", () => {
      // Write garbage directly so getJSON has something to choke on.
      localStorage.setItem("k", "{not valid json");
      expect(storage.getJSON(localStorage, "k")).toBeNull();
    });

    it("works with sessionStorage as the area argument", () => {
      storage.setString(sessionStorage, "k", "v");
      expect(storage.getString(sessionStorage, "k")).toBe("v");
      // sessionStorage and localStorage are independent.
      expect(storage.getString(localStorage, "k")).toBeNull();
    });
  });

  describe("fails closed when storage throws", () => {
    // Why this matters: in storage-disabled browsers (Safari private mode in
    // older versions, sandboxed iframes, quota exceeded), Storage methods
    // throw. The SDK must keep working — none of these calls should leak
    // exceptions to the caller.

    it("setString swallows exceptions", () => {
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("QuotaExceeded", "QuotaExceededError");
      });
      expect(() => storage.setString(localStorage, "k", "v")).not.toThrow();
    });

    it("getString returns null when getItem throws", () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("storage disabled");
      });
      expect(storage.getString(localStorage, "k")).toBeNull();
    });

    it("remove swallows exceptions", () => {
      vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
        throw new Error("storage disabled");
      });
      expect(() => storage.remove(localStorage, "k")).not.toThrow();
    });

    it("setJSON swallows exceptions from setItem", () => {
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("QuotaExceeded", "QuotaExceededError");
      });
      expect(() => storage.setJSON(localStorage, "k", { a: 1 })).not.toThrow();
    });

    it("getJSON returns null when getItem throws", () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("storage disabled");
      });
      expect(storage.getJSON(localStorage, "k")).toBeNull();
    });
  });
});
