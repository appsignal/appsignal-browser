import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { storage, seededRandom } from "./utils.js";

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

describe("seededRandom", () => {
  it("is deterministic — same seed yields the same value", () => {
    expect(seededRandom("abc")).toBe(seededRandom("abc"));
    expect(seededRandom("a-fairly-long-session-id-string")).toBe(
      seededRandom("a-fairly-long-session-id-string"),
    );
  });

  it("returns a value in [0, 1)", () => {
    for (const s of ["", "a", "abc", "0", "🙂", "x".repeat(200)]) {
      const v = seededRandom(s);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("distinguishes nearby seeds — single-char change moves the output", () => {
    // FNV-1a's avalanche means "abc" and "abd" should land far apart.
    expect(seededRandom("abc")).not.toBe(seededRandom("abd"));
    expect(seededRandom("session-1")).not.toBe(seededRandom("session-2"));
  });

  it("spreads roughly uniformly across [0, 1) for varied inputs", () => {
    // 1000 distinct UUID-shaped seeds; a 10-bucket histogram should land
    // within plausible binomial fluctuation (expect 100/bucket, ±3σ ≈ ±30).
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 1000; i++) {
      const v = seededRandom(`seed-${i}-${i * 31}`);
      buckets[Math.floor(v * 10)]++;
    }
    for (const count of buckets) {
      expect(count).toBeGreaterThan(50);
      expect(count).toBeLessThan(150);
    }
  });

  it("the threshold mechanic preserves the sample fraction", () => {
    // Across many seeds, P(seededRandom(s) < 0.1) should be ≈ 0.1.
    let below = 0;
    const N = 5000;
    for (let i = 0; i < N; i++) {
      if (seededRandom(`uuid-fixture-${i}-${i * 7}`) < 0.1) below++;
    }
    // Binomial 5000 × 0.1 has σ ≈ 21; 4σ ≈ 84. Use 100 to be safely robust.
    expect(below).toBeGreaterThan(500 - 100);
    expect(below).toBeLessThan(500 + 100);
  });
});
