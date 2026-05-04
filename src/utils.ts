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
