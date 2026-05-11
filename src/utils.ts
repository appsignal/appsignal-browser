// Defensive wrappers around the Web Storage API. `Storage` is the DOM
// interface implemented by `localStorage` and `sessionStorage` (defined in
// lib.dom.d.ts). Direct calls throw when storage is disabled (Safari private
// mode in older versions, corporate policy, sandboxed iframes) or when quota
// is exceeded. Every storage operation in this SDK should go through these
// so a single failed write can't crash init or a flush.
export const storage = {
  getString(area: Storage, key: string): string | null {
    try { return area.getItem(key); } catch { return null; }
  },
  setString(area: Storage, key: string, value: string): void {
    try { area.setItem(key, value); } catch { /* ignore */ }
  },
  remove(area: Storage, key: string): void {
    try { area.removeItem(key); } catch { /* ignore */ }
  },
  getJSON<T>(area: Storage, key: string): T | null {
    try {
      const raw = area.getItem(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch { return null; }
  },
  setJSON(area: Storage, key: string, value: unknown): void {
    try { area.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  },
};

export function safeUrl(url: string): URL | null {
  try {
    return new URL(url, location.origin);
  } catch {
    return null;
  }
}

/** Scrub a URL by applying an allowlist of query-param keys to both `?query`
 * and the `#fragment` (when the fragment looks like `k=v&k=v` rather than a
 * route or anchor).
 *
 * Allowlist entries are glob-matched (e.g. `utm_*` keeps every UTM param).
 *
 * Fragment heuristic:
 *  - no `=` → opaque (anchor) → preserved verbatim
 *  - starts with `/` → hash route, maybe with embedded query → preserved verbatim
 *  - parses as URLSearchParams and round-trips identically → query-like
 *    (e.g. OAuth implicit `#access_token=...`) → allowlist applied
 *  - otherwise → preserved verbatim
 *
 * This defends against OAuth implicit flow leaks while keeping hash-routed
 * apps (React Router HashRouter, etc.) usable without an extra knob. */
export function scrubUrl(url: string, allowlist: Set<string> | string[]): string {
  if (!url) return url;
  try {
    const parsed = new URL(url, location.origin);
    const list = allowlist instanceof Set ? Array.from(allowlist) : allowlist;
    const isAllowed = (key: string) => list.some((p) => globMatch(p, key));

    const filterParams = (params: URLSearchParams): string => {
      const kept = new URLSearchParams();
      for (const [k, v] of params) {
        if (isAllowed(k)) kept.append(k, v);
      }
      return kept.toString();
    };

    const qs = filterParams(parsed.searchParams);

    const rawHash = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : "";
    let hashOut = "";
    if (rawHash) {
      if (!rawHash.includes("=") || rawHash.startsWith("/")) {
        hashOut = `#${rawHash}`;
      } else {
        const hashParams = new URLSearchParams(rawHash);
        if (hashParams.toString() === rawHash) {
          const scrubbed = filterParams(hashParams);
          hashOut = scrubbed ? `#${scrubbed}` : "";
        } else {
          hashOut = `#${rawHash}`;
        }
      }
    }

    return parsed.origin + parsed.pathname + (qs ? `?${qs}` : "") + hashOut;
  } catch {
    return url;
  }
}

export function globMatch(pattern: string, input: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "⁑")
    .replace(/\*/g, "[^/]*")
    .replace(/⁑/g, ".*");
  return new RegExp(`^${regex}$`).test(input);
}

/** Deterministic Math.random() replacement keyed on a seed string. Returns a
 * value uniformly distributed in [0, 1) — given any threshold T, exactly the
 * fraction T of inputs hash below it. The same seed always produces the same
 * output, which is what makes session-stable sampling work: every page load
 * within a session lands on the same side of the threshold.
 *
 * Implemented as 32-bit FNV-1a over the input bytes, then divided by 2^32 to
 * map into the unit interval. Math.imul keeps the multiplication in 32-bit
 * unsigned space; (h >>> 0) coerces the signed result back to unsigned before
 * the divide. */
export function seededRandom(seed: string): number {
  let h = 2166136261; // FNV offset basis
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619); // FNV prime
  }
  return (h >>> 0) / 0x100000000;
}
