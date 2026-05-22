/** Client-side configuration. All knobs live here — there is no server-side
 * config fetch. Every group is optional; only `key` is required. */
export interface BrowserConfig {
  key: string;
  endpoint?: string;
  appVersion?: string;
  user?: UserContext;
  /** Inspect or modify each error at the entry point, before the SDK adds an
   * error breadcrumb, records `lastErrorTimestamp`, or runs deduplication.
   * Return null to drop the error entirely — none of those side effects fire.
   * Mutate fields to filter or redact (message, stack, etc.). Receives an
   * `IncomingError`, *not* the full payload: breadcrumbs and session are
   * attached later. Use `beforeBreadcrumb` to filter or redact those. Sync
   * only — Promise returns are detected, logged, and the error dropped. */
  beforeError?: (event: IncomingError) => IncomingError | null;
  /** Inspect or modify each breadcrumb at the moment it's pushed into the
   * ring buffer, before any flush. Fires for every breadcrumb the SDK
   * collects (network, click, navigation, console, error, manual). Return
   * null to drop it — the breadcrumb never enters the buffer and ships in
   * neither error payloads nor periodic events payloads. Mutate to redact
   * (PII in messages, sensitive data fields). Runs on the page's hot path;
   * keep it cheap. */
  beforeBreadcrumb?: (breadcrumb: Breadcrumb) => Breadcrumb | null;
  /** URL patterns to inject trace context headers into. Glob syntax. */
  tracePropagationTargets?: string[];

  errors?: ErrorsConfig;
  breadcrumbs?: BreadcrumbsConfig;
  webVitals?: WebVitalsConfig;
  session?: SessionConfig;
  /** Cross-cutting privacy controls. Each knob lists the subsystems that
   * consume it; if no subsystem applies (e.g. error messages, console args)
   * the knob has no effect there. Channel-specific knobs (e.g.
   * `breadcrumbs.networkBlocklist`) stay in their feature namespace. */
  privacy?: PrivacyConfig;
}

export interface ErrorsConfig {
  enabled?: boolean;
  sampleRate?: number;
}

export interface BreadcrumbsConfig {
  enabled?: boolean;
  network?: boolean;
  networkBlocklist?: string[];
  console?: boolean;
  clicks?: boolean;
  longTasks?: boolean;
  scrollDepth?: boolean;
  formAbandonment?: boolean;
  userTiming?: boolean;
  capacity?: number;
}

export interface WebVitalsConfig {
  enabled?: boolean;
}

export interface SessionConfig {
  inactivityTimeoutMs?: number;
}

export interface PrivacyConfig {
  /** Query-string keys to keep in captured URLs. Empty list strips all
   * params. Glob-matched (e.g. `"utm_*"` keeps every UTM key).
   *
   * Fragments are scrubbed by the same allowlist *only when they look like
   * a query string* (`#k=v&k=v`); hash routes (`#/route`) and opaque
   * anchors (`#section-1`) are preserved.
   *
   * Applied to:
   *  - network breadcrumb URLs (request/response capture)
   *  - SPA navigation breadcrumbs (`data.from`, `data.to`)
   *  - `session_context.page_url` and `session_context.referrer`
   *  - `web_vitals.page_url` */
  queryParamsAllowlist?: string[];
  /** DOM-derived captures only. Selectors are CSS selectors evaluated
   * against live DOM nodes; they have no effect on data that isn't sourced
   * from an element (error messages, console args, network bodies). */
  dom?: PrivacyDomConfig;
}

export interface PrivacyDomConfig {
  /** CSS selectors whose **text content** is masked. The element itself,
   * its structure, and its non-text attributes are still recorded — only
   * the visible text is replaced. Applied to click breadcrumb text content
   * (→ `"[masked]"`) when the click target matches or descends from a
   * listed selector. */
  maskText?: string[];
  /** CSS selectors whose **elements are entirely excluded** from capture.
   * Click breadcrumbs — and any rage/dead/error click derived from them —
   * are suppressed when the click target matches or descends from a listed
   * selector. */
  blockElement?: string[];
}

/** Fully-resolved config (every field present) — the shape modules see
 * after defaults are merged with the user's input. Distinct from
 * BrowserConfig because that has Partial groups for ergonomic init() calls. */
export interface ResolvedConfig {
  errors: Required<ErrorsConfig>;
  breadcrumbs: Required<BreadcrumbsConfig>;
  webVitals: Required<WebVitalsConfig>;
  session: Required<SessionConfig>;
  privacy: {
    queryParamsAllowlist: string[];
    dom: Required<PrivacyDomConfig>;
  };
}

export const DEFAULT_CONFIG: ResolvedConfig = {
  errors: { enabled: true, sampleRate: 1.0 },
  breadcrumbs: {
    enabled: true,
    network: true,
    networkBlocklist: [],
    console: true,
    clicks: true,
    longTasks: true,
    scrollDepth: true,
    formAbandonment: true,
    // Off by default — heavy developer instrumentation can flood the ring buffer.
    userTiming: false,
    capacity: 100,
  },
  webVitals: { enabled: true },
  session: { inactivityTimeoutMs: 1_800_000 },
  privacy: {
    queryParamsAllowlist: [],
    dom: { maskText: [], blockElement: [] },
  },
};

/** Merge user input over the static defaults. Group-level only — leaf
 * arrays replace rather than concat, which is what users want for an
 * allowlist/blocklist. */
export function resolveConfig(input: BrowserConfig): ResolvedConfig {
  const d = DEFAULT_CONFIG;
  return {
    errors: { ...d.errors, ...input.errors },
    breadcrumbs: { ...d.breadcrumbs, ...input.breadcrumbs },
    webVitals: { ...d.webVitals, ...input.webVitals },
    session: { ...d.session, ...input.session },
    privacy: {
      queryParamsAllowlist:
        input.privacy?.queryParamsAllowlist ?? d.privacy.queryParamsAllowlist,
      dom: { ...d.privacy.dom, ...input.privacy?.dom },
    },
  };
}

export interface UserContext {
  id?: string;
  email?: string;
  name?: string;
}

export interface Breadcrumb {
  timestamp: number;
  category: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface SessionContext {
  session_id: string;
  /** Per-tab identifier. Stable for the lifetime of one tab (survives reloads,
   * unique to the tab). Lets the server reconstruct cross-tab journeys: one
   * session_id grouping many tab_ids that ran concurrently. */
  tab_id: string;
  anonymous_id: string;
  page_url: string;
  referrer: string;
  user_agent: string;
  screen_width: number;
  screen_height: number;
  viewport_width: number;
  viewport_height: number;
  language: string;
  timezone: string;
  connection_type?: string;
  device_memory?: number;
  user_id?: string;
  user_email?: string;
  user_name?: string;
}

/** The error as seen by `beforeError` — early-pipeline, before breadcrumbs
 * and session are attached. Mutating any field on the returned object
 * propagates into the eventual `BrowserError` payload. */
export interface IncomingError {
  message: string;
  /** Error constructor name (e.g. "TypeError"). Set when known. */
  error_class?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  stack?: string;
  context?: Record<string, unknown>;
}

export interface BrowserError {
  type: "error";
  timestamp: number;
  message: string;
  /** Error constructor name (e.g. "TypeError"). Sent when known. */
  error_class?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  stack?: string;
  breadcrumbs: Breadcrumb[];
  session: SessionContext;
  app_version?: string;
  suppressed_count?: number;
  context?: Record<string, unknown>;
}

export interface VitalEntry {
  name: string;
  value: number;
  rating: string;
  page_url: string;
  timestamp: number;
  element?: string;
  interaction_type?: string;
}

export interface EventPayload {
  type: "events";
  session: SessionContext;
  breadcrumbs: Breadcrumb[];
  vitals: VitalEntry[];
  app_version?: string;
}

export interface ReplayChunk {
  type: "replay";
  session_id: string;
  /** Per-tab id. Together with session_id and chunk_index, uniquely keys a
   * chunk on the server. Without this, two tabs of the same session both
   * produce chunk_index=0,1,2,… and collide. */
  tab_id: string;
  chunk_index: number;
  events: unknown[];
  app_version?: string;
}

// ─── Session replay (v1: not wired) ──────────────────────────────────────
// The replay module still lives in src/replay.ts but isn't imported by
// index.ts and isn't bundled. These types travel with it so the module
// stays self-consistent and the tests keep running. When replay returns
// for v2+, these get folded back into BrowserConfig/ResolvedConfig.

export interface ReplayConfig {
  enabled: boolean;
  sample_rate: number;
  error_replay: boolean;
  /** rrweb's `maskAllInputs`: every form-field value renders as `***`. */
  mask_all_inputs: boolean;
  max_duration_ms: number;
}

export interface ReplayPrivacyDom {
  /** CSS selectors whose text is replaced with `*` in rrweb output. */
  mask_text: string[];
  /** CSS selectors whose elements are replaced with a placeholder. */
  block_element: string[];
}

export const DEFAULT_REPLAY_CONFIG: ReplayConfig = {
  enabled: true,
  sample_rate: 1.0,
  error_replay: true,
  mask_all_inputs: true,
  max_duration_ms: 14_400_000, // 4 hours
};
