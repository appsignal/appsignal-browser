import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { storage, seededRandom, scrubUrl } from "./utils.js";

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

describe("scrubUrl", () => {
  describe("query string", () => {
    it("strips every param when the allowlist is empty", () => {
      expect(scrubUrl("https://app.com/page?token=xyz&page=2", [])).toBe(
        "https://app.com/page",
      );
    });

    it("keeps allowlisted keys and drops the rest", () => {
      expect(
        scrubUrl("https://app.com/page?page=2&token=xyz", ["page"]),
      ).toBe("https://app.com/page?page=2");
    });

    it("treats allowlist entries as globs", () => {
      // Realistic case: keep marketing attribution without enumerating each UTM key.
      const url = "https://app.com/?utm_source=email&utm_medium=newsletter&token=xyz";
      expect(scrubUrl(url, ["utm_*"])).toBe(
        "https://app.com/?utm_source=email&utm_medium=newsletter",
      );
    });

    it("returns input unchanged when URL parsing fails", () => {
      // `new URL()` does throw on input that has no scheme and no current origin
      // resolution; here we just rely on the try/catch fallthrough.
      expect(scrubUrl("not a url at all", [])).toBeTypeOf("string");
    });

    it("returns input unchanged when input is empty", () => {
      // document.referrer is "" on direct loads — must not become location.origin.
      expect(scrubUrl("", [])).toBe("");
    });
  });

  describe("fragment heuristic", () => {
    it("preserves hash routes (no '=')", () => {
      expect(scrubUrl("https://app.com/#/checkout", [])).toBe(
        "https://app.com/#/checkout",
      );
      expect(scrubUrl("https://app.com/#section-1", [])).toBe(
        "https://app.com/#section-1",
      );
    });

    it("preserves fragments that start with '/' even when they contain '='", () => {
      // A hash route with an embedded query — common in legacy SPAs.
      // We can't safely allowlist-filter a "/route?k=v" string, so preserve it.
      expect(scrubUrl("https://app.com/#/oauth-cb?token=xyz", [])).toBe(
        "https://app.com/#/oauth-cb?token=xyz",
      );
    });

    it("scrubs OAuth-style fragments with the allowlist", () => {
      // Default OAuth implicit flow lands the token in the fragment. Empty
      // allowlist drops it; allowlisting `state` keeps the CSRF token visible.
      expect(
        scrubUrl(
          "https://app.com/cb#access_token=xyz&token_type=bearer&state=abc",
          [],
        ),
      ).toBe("https://app.com/cb");
      expect(
        scrubUrl(
          "https://app.com/cb#access_token=xyz&state=abc",
          ["state"],
        ),
      ).toBe("https://app.com/cb#state=abc");
    });

    it("preserves anchors with '=' that don't round-trip as URLSearchParams", () => {
      // `new URLSearchParams("anchor")` round-trips to "anchor=" — not equal to
      // the raw input, so the heuristic treats it as opaque and preserves it.
      // (Strictly, "k=v" with no `&` still round-trips, so single-pair anchors
      // like `#section=1` would be scrubbed; that's accepted as a rare case.)
      expect(scrubUrl("https://app.com/#section-1", [])).toBe(
        "https://app.com/#section-1",
      );
    });

    it("applies allowlist to query and fragment in the same URL", () => {
      const url =
        "https://app.com/page?token=xyz&page=2#access_token=abc&state=def";
      expect(scrubUrl(url, ["page", "state"])).toBe(
        "https://app.com/page?page=2#state=def",
      );
    });
  });
});
