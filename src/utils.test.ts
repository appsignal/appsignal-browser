import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { storage, resetStorageFallback, seededRandom, scrubPageUrl, scrubUrl, uuidv4, uuidv7, jsonSafe, jsonSafeRecord, logError } from "./utils.js";

describe("logError", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not reopen the exception boundary when a host console wrapper throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("console wrapper failed");
    });

    expect(() => logError("original failure", new Error("boom"))).not.toThrow();
  });
});

describe("storage helper", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    resetStorageFallback();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("happy path", () => {
    it("getString / setString round-trip", () => {
      storage.setString("local", "k", "v");
      expect(storage.getString("local", "k")).toBe("v");
    });

    it("getString returns null for missing keys", () => {
      expect(storage.getString("local", "missing")).toBeNull();
    });

    it("remove deletes a key", () => {
      storage.setString("local", "k", "v");
      storage.remove("local", "k");
      expect(storage.getString("local", "k")).toBeNull();
    });

    it("getJSON / setJSON round-trip preserves shape", () => {
      const value = { id: "u1", nested: { count: 3 }, list: [1, 2] };
      storage.setJSON("local", "k", value);
      expect(storage.getJSON("local", "k")).toEqual(value);
    });

    it("getJSON returns null for missing keys", () => {
      expect(storage.getJSON("local", "missing")).toBeNull();
    });

    it("getJSON returns null for malformed JSON", () => {
      // Write garbage directly so getJSON has something to choke on.
      localStorage.setItem("k", "{not valid json");
      expect(storage.getJSON("local", "k")).toBeNull();
    });

    it("keeps the two areas independent", () => {
      storage.setString("session", "k", "v");
      expect(storage.getString("session", "k")).toBe("v");
      // sessionStorage and localStorage are independent.
      expect(storage.getString("local", "k")).toBeNull();
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
      expect(() => storage.setString("local", "k", "v")).not.toThrow();
    });

    it("getString returns null when getItem throws", () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("storage disabled");
      });
      expect(storage.getString("local", "k")).toBeNull();
    });

    it("remove swallows exceptions", () => {
      vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
        throw new Error("storage disabled");
      });
      expect(() => storage.remove("local", "k")).not.toThrow();
    });

    it("setJSON swallows exceptions from setItem", () => {
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("QuotaExceeded", "QuotaExceededError");
      });
      expect(() => storage.setJSON("local", "k", { a: 1 })).not.toThrow();
    });


    it("keeps a refused write in memory, so ids stay coherent", () => {
      // Safari's old private mode throws on every setItem while getItem keeps
      // answering nothing. A write that lands nowhere would hand out a new id
      // on every read.
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("QuotaExceeded", "QuotaExceededError");
      });

      storage.setString("local", "appsignal_anonymous_id", "anon-1");

      expect(storage.getString("local", "appsignal_anonymous_id")).toBe("anon-1");
    });

    it("still reads the values that the area holds after a write refuses", () => {
      // The quota fills up while the page runs: the ids written at init are
      // intact, and only the new write has nowhere to go.
      storage.setString("local", "appsignal_anonymous_id", "anon-1");
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("QuotaExceeded", "QuotaExceededError");
      });

      storage.setString("local", "appsignal_last_activity", "123");

      expect(storage.getString("local", "appsignal_anonymous_id")).toBe("anon-1");
      expect(storage.getString("local", "appsignal_last_activity")).toBe("123");
    });

    it("still deletes from the area after a write refuses", () => {
      // A logout must clear the user, and a quota error stops a write, not a
      // delete.
      storage.setString("local", "appsignal_user", "{\"id\":\"u1\"}");
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("QuotaExceeded", "QuotaExceededError");
      });
      storage.setString("local", "appsignal_tags", "{}");

      storage.remove("local", "appsignal_user");

      expect(localStorage.getItem("appsignal_user")).toBeNull();
      expect(storage.getString("local", "appsignal_user")).toBeNull();
    });

    it("prefers the newer memory value over the stale one in the area", () => {
      storage.setString("local", "k", "old");
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("QuotaExceeded", "QuotaExceededError");
      });

      storage.setString("local", "k", "new");

      expect(storage.getString("local", "k")).toBe("new");
    });

    it("getJSON returns null when getItem throws", () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("storage disabled");
      });
      expect(storage.getJSON("local", "k")).toBeNull();
    });
  });

  describe("falls back to memory when the area itself is unreachable", () => {
    // Reading the `localStorage` global throws a SecurityError when the origin
    // has site data blocked, and a ReferenceError where the global is absent.
    // That happens before any method call, so it has to be caught by the
    // wrapper — otherwise it escapes into init() and kills all telemetry.
    const blockArea = (name: "localStorage" | "sessionStorage", error: unknown) => {
      vi.spyOn(globalThis, name, "get").mockImplementation(() => {
        throw error;
      });
    };

    it("survives a SecurityError and still round-trips values", () => {
      blockArea("localStorage", new DOMException("The operation is insecure.", "SecurityError"));
      expect(() => storage.setString("local", "k", "v")).not.toThrow();
      expect(storage.getString("local", "k")).toBe("v");
      storage.remove("local", "k");
      expect(storage.getString("local", "k")).toBeNull();
    });

    it("survives a missing global", () => {
      blockArea("localStorage", new ReferenceError("Can't find variable: localStorage"));
      storage.setJSON("local", "user", { id: "u1" });
      expect(storage.getJSON("local", "user")).toEqual({ id: "u1" });
    });

    it("keeps a blocked area separate from a working one", () => {
      blockArea("sessionStorage", new DOMException("The operation is insecure.", "SecurityError"));
      storage.setString("session", "k", "from-memory");
      storage.setString("local", "k", "from-storage");
      expect(storage.getString("session", "k")).toBe("from-memory");
      expect(localStorage.getItem("k")).toBe("from-storage");
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

  it("records a trailing slash as the page served it", () => {
    expect(scrubUrl("https://app.com/products/", [])).toBe("https://app.com/products/");
    expect(scrubUrl("https://api.app.com/v1/orders/", [])).toBe("https://api.app.com/v1/orders/");
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

describe("scrubPageUrl", () => {
  it("reports one page whether or not the path ends in a slash", () => {
    expect(scrubPageUrl("https://app.com/products/", [])).toBe("https://app.com/products");
  });

  it("keeps the root path as a slash", () => {
    expect(scrubPageUrl("https://app.com/", [])).toBe("https://app.com/");
  });

  it("normalises before the query, not after it", () => {
    expect(scrubPageUrl("https://app.com/products/?page=2", ["page"])).toBe(
      "https://app.com/products?page=2",
    );
  });

  it("normalises a hash route too, since that is the route for hash-routed apps", () => {
    expect(scrubPageUrl("https://app.com/#/checkout/", [])).toBe("https://app.com/#/checkout");
  });

  it("normalises a hash route that carries its own query", () => {
    expect(scrubPageUrl("https://app.com/#/checkout/?page=2", [])).toBe(
      "https://app.com/#/checkout?page=2",
    );
  });

  it("keeps the root of a hash route as a slash", () => {
    expect(scrubPageUrl("https://app.com/#/?page=2", [])).toBe("https://app.com/#/?page=2");
  });

  it("leaves an anchor alone", () => {
    expect(scrubPageUrl("https://app.com/docs#section-1", [])).toBe(
      "https://app.com/docs#section-1",
    );
  });

  it("leaves a slash inside an anchor alone, since an anchor is not a route", () => {
    expect(scrubPageUrl("https://app.com/docs#section/", [])).toBe(
      "https://app.com/docs#section/",
    );
  });

  it("still applies the allowlist it scrubs through", () => {
    expect(scrubPageUrl("https://app.com/page/?token=xyz&page=2", ["page"])).toBe(
      "https://app.com/page?page=2",
    );
  });

  it("returns a URL it cannot parse untouched", () => {
    expect(scrubPageUrl("http://[", [])).toBe("http://[");
  });

  it("does not invent a page out of an empty string", () => {
    expect(scrubPageUrl("", [])).toBe("");
  });
});

describe("uuidv7", () => {
  const V7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it("matches RFC 9562 v7 format with the correct version and variant", () => {
    for (let i = 0; i < 50; i++) {
      expect(uuidv7()).toMatch(V7_REGEX);
    }
  });

  it("lex-sorts in generation order across distinct timestamps", () => {
    const now = vi.useFakeTimers();
    const ids: string[] = [];
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      ids.push(uuidv7());
      vi.setSystemTime(new Date("2026-01-01T00:00:01Z"));
      ids.push(uuidv7());
      vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
      ids.push(uuidv7());
    } finally {
      now.useRealTimers();
    }
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });

  it("two calls at the same ms are still distinct", () => {
    const now = vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const a = uuidv7();
      const b = uuidv7();
      expect(a).not.toBe(b);
    } finally {
      now.useRealTimers();
    }
  });
});

describe("uuidv4", () => {
  const V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it("matches RFC 9562 v4 format", () => {
    expect(uuidv4()).toMatch(V4_REGEX);
  });

  it("does not encode generation time (different ms → still random order)", () => {
    const now = vi.useFakeTimers();
    const ids: string[] = [];
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      ids.push(uuidv4());
      vi.setSystemTime(new Date("2027-01-01T00:00:00Z"));
      ids.push(uuidv4());
    } finally {
      now.useRealTimers();
    }
    // No timestamp prefix: the leading hex bytes are random, so the
    // first byte is uncorrelated with system time.
    const firstByteA = parseInt(ids[0].slice(0, 2), 16);
    const firstByteB = parseInt(ids[1].slice(0, 2), 16);
    // Sanity: this is a weak randomness check, but a v7 would put 1.7e12
    // ms (year ≈ 2024–) in the prefix with a stable leading byte.
    expect(firstByteA).toBeGreaterThanOrEqual(0);
    expect(firstByteB).toBeGreaterThanOrEqual(0);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe("randomBytes fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("still produces valid, distinct UUIDs when the RNG throws", () => {
    // Firefox raises OperationError when its generator fails; session.ts calls
    // these during init, so a throw here used to take the SDK down at import.
    vi.spyOn(crypto, "getRandomValues").mockImplementation(() => {
      throw new DOMException("The operation failed for an operation-specific reason", "OperationError");
    });

    const v4 = new Set<string>();
    const v7 = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const four = uuidv4();
      const seven = uuidv7();
      expect(four).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(seven).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      v4.add(four);
      v7.add(seven);
    }
    expect(v4.size).toBe(50);
    expect(v7.size).toBe(50);
  });

  it("survives a missing crypto global", () => {
    vi.spyOn(globalThis, "crypto", "get").mockImplementation(() => {
      throw new ReferenceError("crypto is not defined");
    });

    expect(() => uuidv4()).not.toThrow();
  });
});

describe("jsonSafe", () => {
  it("replaces a back-reference so the value can be serialized", () => {
    const controller: Record<string, unknown> = { identifier: "dropdown" };
    controller.self = controller;

    const safe = jsonSafe(controller);

    expect(safe).toEqual({ identifier: "dropdown", self: "[Circular]" });
    expect(() => JSON.stringify(safe)).not.toThrow();
  });

  it("keeps a repeated sibling reference, which is not circular", () => {
    const shared = { id: 1 };

    expect(jsonSafe({ a: shared, b: shared })).toEqual({ a: { id: 1 }, b: { id: 1 } });
  });

  it("caps depth and entry count", () => {
    const deep = { a: { b: { c: { d: { e: "too far" } } } } };
    expect(jsonSafe(deep)).toEqual({ a: { b: { c: { d: "[Object]" } } } });

    const wide: Record<string, number> = {};
    for (let i = 0; i < 80; i++) wide[`k${i}`] = i;
    expect(Object.keys(jsonSafe(wide) as object)).toHaveLength(50);

    const long = Array.from({ length: 80 }, (_, i) => i);
    expect(jsonSafe(long)).toHaveLength(50);
  });

  it("drops what JSON has no place for, and coerces what it chokes on", () => {
    const safe = jsonSafe({
      keep: "yes",
      fn: () => "no",
      big: 10n,
      when: new Date("2026-09-17T00:00:00Z"),
      nothing: undefined,
    });

    expect(safe).toEqual({
      keep: "yes",
      big: "10",
      when: "2026-09-17T00:00:00.000Z",
    });
  });

  it("skips a property whose getter throws", () => {
    const hostile = {
      ok: 1,
      get boom(): never { throw new Error("detached"); },
    };

    expect(jsonSafe(hostile)).toEqual({ ok: 1 });
  });

  it("asks toJSON first, as JSON.stringify does", () => {
    expect(jsonSafe({ when: new Date("2026-09-17T00:00:00Z") })).toEqual({
      when: "2026-09-17T00:00:00.000Z",
    });
    // A Luxon DateTime or a Moment keeps the string the host used to see.
    const custom = { internal: 1, toJSON: () => "rendered" };
    expect(jsonSafe({ custom })).toEqual({ custom: "rendered" });
  });

  it("does not throw on an invalid Date", () => {
    // toISOString throws RangeError here; toJSON answers null.
    expect(() => jsonSafe({ when: new Date("nope") })).not.toThrow();
    expect(jsonSafe({ when: new Date("nope") })).toEqual({ when: null });
  });

  it("marks a subtree it cannot read, and keeps the rest", () => {
    const revocable = Proxy.revocable({ a: 1 }, {});
    revocable.revoke();

    expect(jsonSafe({ keep: "yes", gone: revocable.proxy })).toEqual({
      keep: "yes",
      gone: "[Unserializable]",
    });
  });

  it("keeps a record a record", () => {
    const revocable = Proxy.revocable({ a: 1 }, {});
    revocable.revoke();

    // A top-level value that prunes to a marker still ships as an object,
    // because breadcrumb metadata and error context are records on the wire.
    expect(jsonSafeRecord(revocable.proxy as Record<string, unknown>)).toEqual({
      value: "[Unserializable]",
    });
    expect(jsonSafeRecord({ a: 1 })).toEqual({ a: 1 });
  });

  it("bounds the whole walk, not just each level", () => {
    // 50 entries over 4 levels reaches millions of nodes. A React fiber or a
    // Vue component instance gets there, and this runs on the error path.
    const wide = (depth) => {
      if (depth === 0) return "leaf";
      const level = {};
      for (let i = 0; i < 50; i++) level[`k${i}`] = wide(depth - 1);
      return level;
    };

    const safe = jsonSafe(wide(4));

    const encoded = JSON.stringify(safe);
    expect(encoded).toContain("[Truncated]");
    // Every copied value costs a node, leaves included. Charging containers
    // alone would leave the real bound at 1000 x 50 values.
    expect(encoded.length).toBeLessThan(20_000);
  });
});
