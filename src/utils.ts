// Defensive wrappers around Storage. Direct localStorage/sessionStorage
// access throws when storage is disabled (Safari private mode in older
// versions, corporate policy, sandboxed iframes) or when quota is exceeded.
// Every storage operation in this SDK should go through these so a single
// failed write can't crash init or a flush.
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

export function filterQueryParams(url: string, allowlist: Set<string> | string[]): string {
  try {
    const parsed = new URL(url, location.origin);
    const allowSet = allowlist instanceof Set ? allowlist : new Set(allowlist);
    if (allowSet.size === 0) {
      return parsed.origin + parsed.pathname;
    }
    const allowed = new URLSearchParams();
    for (const [key, value] of parsed.searchParams) {
      if (allowSet.has(key)) {
        allowed.append(key, value);
      }
    }
    const qs = allowed.toString();
    return parsed.origin + parsed.pathname + (qs ? `?${qs}` : "");
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
