// Defensive wrappers around the Web Storage API, addressed by area name
// rather than by a `Storage` object: reading the `localStorage` global is
// itself a throwing operation — SecurityError when the origin's site data is
// blocked (browser setting, corporate policy, sandboxed iframe), ReferenceError
// when the global is absent — so the area has to be resolved inside the guard
// or it throws past the call site. Individual operations throw too, when
// storage is disabled or quota is exceeded. Every storage operation in this
// SDK should go through these so a single failed read can't crash init or a
// flush.
// --- Storage ---

export type StorageArea = "local" | "session";

// Stands in for an unreachable area so anonymous_id / tab_id / session_id stay
// coherent for the page lifetime instead of being empty. Not persisted, so
// these visitors look like a new session on every page load.
const fallback: Record<StorageArea, Map<string, string>> = {
  local: new Map(),
  session: new Map(),
};

function resolveArea(area: StorageArea): Storage | null {
  try {
    return (area === "local" ? localStorage : sessionStorage) ?? null;
  } catch {
    return null;
  }
}

/** Drop the in-memory fallback. Nothing in the SDK calls this, because what
 * the map stands in for lasts as long as the page. Tests do, because the map
 * outlives one example. */
export function resetStorageFallback(): void {
  fallback.local.clear();
  fallback.session.clear();
}

export const storage = {
  // The memory map answers first. It holds a key only after a write to the
  // real area failed, which makes it the newer value of the two.
  getString(area: StorageArea, key: string): string | null {
    const remembered = fallback[area].get(key);
    if (remembered !== undefined) return remembered;
    const store = resolveArea(area);
    if (!store) return null;
    try { return store.getItem(key); } catch { return null; }
  },
  setString(area: StorageArea, key: string, value: string): void {
    const store = resolveArea(area);
    if (store) {
      try {
        store.setItem(key, value);
        // The real area holds the value again, so drop the older copy.
        fallback[area].delete(key);
        return;
      } catch { /* the area refused this write */ }
    }
    fallback[area].set(key, value);
  },
  remove(area: StorageArea, key: string): void {
    fallback[area].delete(key);
    const store = resolveArea(area);
    if (!store) return;
    // A quota error stops a write, not a delete, so always try the real area.
    try { store.removeItem(key); } catch { /* ignore */ }
  },
  getJSON<T>(area: StorageArea, key: string): T | null {
    const raw = storage.getString(area, key);
    if (!raw) return null;
    try { return JSON.parse(raw) as T; } catch { return null; }
  },
  setJSON(area: StorageArea, key: string, value: unknown): void {
    // JSON.stringify throws on circular structures and BigInt values.
    try { storage.setString(area, key, JSON.stringify(value)); } catch { /* ignore */ }
  },
};

// --- JSON pruning ---

const MAX_JSON_DEPTH = 4;
const MAX_JSON_ENTRIES = 50;
// Depth and entry count bound each level, not the total: 50 entries over 4
// levels reaches 6 million nodes. A React fiber or a Vue component instance
// gets there without trying, and the copy runs on the error path, where the
// SDK must stay out of the host's way. This caps the whole walk.
const MAX_JSON_NODES = 1000;

/** Copy a host-supplied value into a shape `JSON.stringify` can serialize.
 *
 * Breadcrumb `data` and error `context` hold whatever host code passes: a
 * framework controller, a React element, a DOM node. Those point back at
 * themselves, and a circular structure makes `JSON.stringify` throw inside
 * `sendError`, where the throw reaches the caller of `captureError`.
 *
 * Pruning at capture keeps the rest of the payload, and releases the host's
 * object graph. The caps bound the copy, because one controller reaches most
 * of the application through its own properties. */
export function jsonSafe(value: unknown): unknown {
  return copyValue(value, 0, [], { left: MAX_JSON_NODES });
}

interface NodeBudget { left: number }

function copyValue(value: unknown, depth: number, ancestors: object[], budget: NodeBudget): unknown {
  // Every copied value costs a node, leaves included. Charging containers
  // alone would leave the real bound at MAX_JSON_NODES × MAX_JSON_ENTRIES.
  if (budget.left <= 0) return "[Truncated]";
  budget.left--;

  if (value === null) return null;

  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") return value;
  if (type === "bigint") return String(value);
  if (type !== "object") return undefined;

  const object = value as object;
  // Ancestors, not every object seen: siblings that share a reference are not
  // circular. The list is never longer than MAX_JSON_DEPTH.
  if (ancestors.includes(object)) return "[Circular]";

  ancestors.push(object);
  try {
    if (depth >= MAX_JSON_DEPTH) return Array.isArray(object) ? "[Array]" : "[Object]";

    // `JSON.stringify` asks for `toJSON` first, so honour it: a Date, a Luxon
    // DateTime or a Moment keeps the string the host used to see, instead of
    // its internal fields. An invalid Date answers `null` here, where
    // `toISOString` would throw.
    const toJSON = (object as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      return copyValue((toJSON as () => unknown).call(object), depth + 1, ancestors, budget);
    }

    if (Array.isArray(object)) {
      return object
        .slice(0, MAX_JSON_ENTRIES)
        .map((entry) => copyValue(entry, depth + 1, ancestors, budget));
    }

    const copy: Record<string, unknown> = {};
    let entries = 0;
    for (const key of Object.keys(object)) {
      if (entries >= MAX_JSON_ENTRIES) break;
      let entry: unknown;
      // A getter can throw (a detached DOM node, a framework proxy), and
      // reading it is the first time we find out.
      try {
        entry = (object as Record<string, unknown>)[key];
      } catch {
        continue;
      }
      const safe = copyValue(entry, depth + 1, ancestors, budget);
      if (safe === undefined) continue;
      copy[key] = safe;
      entries++;
    }
    return copy;
  } catch {
    // A hostile value still throws: a revoked proxy refuses `Object.keys` or
    // `Array.isArray`, a `toJSON` fails. Each node catches its own subtree, so
    // one bad branch becomes a marker and the rest of the payload survives.
    return "[Unserializable]";
  } finally {
    ancestors.pop();
  }
}

/** `jsonSafe` for a value that has to stay a record: breadcrumb `data` and
 * error `context` both ship as objects. A top-level marker string, or a
 * `toJSON` that answers a primitive, keeps its value under a key instead of
 * replacing the record with a string. */
export function jsonSafeRecord(value: Record<string, unknown>): Record<string, unknown> {
  const safe = jsonSafe(value);
  if (safe !== null && typeof safe === "object" && !Array.isArray(safe)) {
    return safe as Record<string, unknown>;
  }
  return { value: safe };
}

// --- Logging and host hooks ---

/** The SDK's own failures go to the console under one prefix, so a host can
 * recognise and filter them. One place to change the channel. */
export function logError(message: string, error?: unknown): void {
  // Hosts commonly wrap console methods. Logging is itself part of a failure
  // path, so a missing console or a wrapper that throws must not reopen the
  // exception boundary we just closed.
  try {
    const target = globalThis.console;
    const logger = target?.error;
    if (typeof logger === "function") logger.call(target, `[appsignal] ${message}`, error);
  } catch { /* best effort */ }
}

/** Run one teardown step. Cleanup is a postcondition, not an all-or-nothing
 * sequence: one hostile browser API or foreign wrapper must not prevent the
 * remaining steps, and the failure belongs in the console.
 *
 * Answers whether the step ran, for the callers that keep an "installed" flag:
 * that flag says our patch is on the global, so it may only go down for the
 * ones that came off. */
export function attempt(name: string, fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch (error) {
    logError(`${name} cleanup failed`, error);
    return false;
  }
}

/** Run a host hook. A null return drops the value. A throwing hook is a bug in
 * host code, and must break neither the SDK nor the call it came from, so a
 * throw is a passthrough. Shared by beforeError and beforeBreadcrumb. */
export function applyHook<T>(hook: ((value: T) => T | null) | undefined, value: T): T | null {
  // Hot path: every network request, click and console call reaches this.
  // Skip the call entirely when no hook is configured.
  if (!hook) return value;
  try {
    return hook(value);
  } catch {
    return value;
  }
}

// --- URLs ---

export function safeUrl(url: string): URL | null {
  try {
    return new URL(url, location.origin);
  } catch {
    return null;
  }
}

export function stripTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
}

function stripHashRouteTrailingSlash(hashRoute: string): string {
  const queryStart = hashRoute.indexOf("?");

  return queryStart === -1
    ? stripTrailingSlash(hashRoute)
    : stripTrailingSlash(hashRoute.slice(0, queryStart)) + hashRoute.slice(queryStart);
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
 * apps (React Router HashRouter, etc.) usable without an extra option. */
export function scrubUrl(url: string, allowlist: string[]): string {
  if (!url) return url;
  try {
    const parsed = new URL(url, location.origin);
    const isAllowed = (key: string) => allowlist.some((p) => globMatch(p, key));

    const filterParams = (params: URLSearchParams): string => {
      const kept = new URLSearchParams();
      for (const [k, v] of params) {
        if (isAllowed(k)) kept.append(k, v);
      }
      return kept.toString();
    };

    const qs = filterParams(parsed.searchParams);

    // URL.hash is either "" or starts with "#"; slice(1) handles both.
    const rawHash = parsed.hash.slice(1);
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

export function scrubPageUrl(url: string, allowlist: string[]): string {
  const scrubbed = scrubUrl(url, allowlist);
  const parsed = scrubbed ? safeUrl(scrubbed) : null;
  if (!parsed) return scrubbed;

  const hashRoute = parsed.hash.slice(1);
  const hash = hashRoute.startsWith("/")
    ? `#${stripHashRouteTrailingSlash(hashRoute)}`
    : parsed.hash;

  return parsed.origin + stripTrailingSlash(parsed.pathname) + parsed.search + hash;
}

export function globMatch(pattern: string, input: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "⁑")
    .replace(/\*/g, "[^/]*")
    .replace(/⁑/g, ".*");
  return new RegExp(`^${regex}$`).test(input);
}


// --- Identifiers ---

/** N bytes of randomness. Reaching the generator is not guaranteed: Firefox
 * raises `OperationError` when it fails, and `crypto` is absent in some
 * embedded webviews. The UUID helpers run during init, so an unguarded throw
 * takes the whole SDK down at import.
 *
 * `Math.random` is the fallback. These IDs correlate a visitor, a tab and a
 * session. They carry no secret, so a weaker source costs collision odds, not
 * security. */
export function randomBytes(numBytes: number): Uint8Array {
  const bytes = new Uint8Array(numBytes);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < numBytes; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return bytes;
}

/** Lowercase hex for N bytes. Shared by the UUID format and the W3C
 * traceparent ids. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** RFC 9562 §5.4 v4: 122 random bits. Use for IDs whose lex order must
 * NOT leak generation time — primarily `anonymous_id`, which persists in
 * localStorage and would otherwise expose first-visit timestamp.
 *
 * Built by hand from `crypto.getRandomValues` rather than
 * `crypto.randomUUID`, which throws "crypto.randomUUID is not a function" in
 * two situations we have to survive — note that `session.ts` calls this at
 * module scope, so a throw takes down the whole SDK at import, not just the
 * anonymous ID:
 *
 *   1. Any page served over plain http:// (bar localhost), on every browser:
 *      randomUUID is secure-context-only. This is the common one.
 *   2. Browsers older than Chrome 92 / Safari 15.4, where it doesn't exist.
 *
 * `getRandomValues` has neither restriction — no secure-context gate, and
 * Chrome 11+ — but it can still throw, hence `randomBytes`. */
export function uuidv4(): string {
  const bytes = randomBytes(16);
  // Bits 48..51: version 4 (0b0100).
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  // Bits 64..65: variant 10.
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
}



/** 16 bytes → canonical 8-4-4-4-12 hex form. Shared so the two generators
 * can't drift in output shape. */
function formatUuid(bytes: Uint8Array): string {
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}


/** RFC 9562 §5.7 v7: 48-bit big-endian Unix-ms timestamp, then version +
 * variant bits, then 74 random bits. Lex-sort of v7 strings matches
 * generation time, which lets the server order tabs / sessions
 * chronologically without peeking into the data. */
export function uuidv7(): string {
  const ts = Date.now();
  const bytes = randomBytes(16);
  // Bits 0..47: timestamp, big-endian. Date.now() fits in 48 bits until year
  // 10889, so the divide/and dance below loses no precision in practice.
  bytes[0] = (ts / 0x10000000000) & 0xff;
  bytes[1] = (ts / 0x100000000) & 0xff;
  bytes[2] = (ts / 0x1000000) & 0xff;
  bytes[3] = (ts / 0x10000) & 0xff;
  bytes[4] = (ts / 0x100) & 0xff;
  bytes[5] = ts & 0xff;
  // Bits 48..51: version 7 (0b0111).
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  // Bits 64..65: variant 10.
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
}

// --- Misc ---

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

/** Normalise anything that behaves like an Error into its reportable fields,
 * or `undefined` if the value isn't error-shaped.
 *
 * `instanceof Error` is not sufficient: an error thrown in another realm (a
 * same-origin iframe, a worker) has that realm's Error constructor, so the
 * check fails — and because `message`/`stack` are non-enumerable,
 * `JSON.stringify` of one yields `"{}"`. Duck-typing recovers those.
 *
 * `name` + `message` is the signal, not `stack`: a data payload like
 * `{ code: 500 }` has neither, and a `DOMException` carries no stack in
 * WebKit. */
export function errorLike(
  value: unknown,
): { name: string; message: string; stack?: string } | undefined {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: typeof value.stack === "string" ? value.stack : undefined,
    };
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { name, message, stack } = value as Record<string, unknown>;
  if (typeof name !== "string" || typeof message !== "string") return undefined;
  return { name, message, stack: typeof stack === "string" ? stack : undefined };
}

/** Epoch ms corresponding to `performance.now() === 0`, for lifting
 * performance-entry times (which are timeOrigin-relative) to wall-clock.
 *
 * `performance.timeOrigin` is Chrome 62+ / Safari 15+ — the same older-browser
 * tail `uuidv4` above exists for leaves it undefined, and `undefined + t` is
 * NaN, which propagates silently: NaN fails every comparison, so a caller
 * filtering entries by a time window rejects all of them and reports no timing
 * at all. Derive the offset from the two clocks instead when it's missing.
 *
 * Not cached — the derived value can drift sub-millisecond between calls as the
 * wall clock is adjusted, which is irrelevant at our ms rounding and 1s match
 * slack, and caching would freeze whichever value the first caller happened to
 * compute. */
export function timeOrigin(): number {
  const origin = performance.timeOrigin;
  if (typeof origin === "number" && !Number.isNaN(origin)) return origin;
  return Date.now() - performance.now();
}
