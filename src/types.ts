/** Client-side configuration. Every group is optional; only `key` is
 * required. */
export interface BrowserConfig {
  key: string;
  endpoint?: string;
  /** Master switch. Defaults to active. Set `false` to make `init()` a complete
   * no-op — nothing is patched (fetch/XHR), no timers start, and no network
   * request ever fires. Every public method (`addBreadcrumb`, `captureError`,
   * …) already no-ops while the SDK is inactive, so app code can
   * call them unconditionally. Gate this on your build environment to keep
   * dev/test/CI from sending data, e.g. `active: import.meta.env.PROD` or
   * `active: process.env.NODE_ENV === "production"`. */
  active?: boolean;
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
  /** Overrides the service name the server records for the page load span.
   * Unset by default, in which case the server defaults it to `"browser"`.
   * Sent on every payload that can describe the span — the `page_load` post,
   * the closing object on the events payload, and error payloads — so the
   * rows always agree on it. Setting it only for some of those payloads is
   * not supported: the server would then have rows disagreeing about the
   * span's identity. */
  serviceName?: string;

  errors?: ErrorsConfig;
  breadcrumbs?: BreadcrumbsConfig;
  session?: SessionConfig;
  /** Cross-cutting privacy controls. Each option lists the subsystems that
   * consume it; if no subsystem applies (e.g. error messages, console args)
   * the option has no effect there. */
  privacy?: PrivacyConfig;
}

export interface ErrorsConfig {
  enabled?: boolean;
  sampleRate?: number;
}

export interface BreadcrumbsConfig {
  network?: boolean;
  console?: boolean;
  clicks?: boolean;
  longTasks?: boolean;
  scrollDepth?: boolean;
}

export interface SessionConfig {
  /** Whether the session/journey stream is *sent* — the periodic `events`
   * payload's breadcrumbs (and, later, session replay). Web vitals always
   * ship and errors (with their own breadcrumb trail via
   * `/ingest/browser/errors`) are unaffected; a `session_id` is still
   * generated for those. Defaults to
   * false: the processor currently ignores session + breadcrumbs on
   * `/ingest/browser` (v1 reads vitals only), so shipping them is wasted
   * bandwidth until the Sessions/Replay tier exists server-side. */
  enabled?: boolean;
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
  /** Glob URL patterns whose requests are never recorded. Matched against
   * host + pathname. Today applied to network breadcrumbs; when replay
   * returns it will gate replay's network capture too. */
  networkBlocklist?: string[];
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
  session: Required<SessionConfig>;
  privacy: {
    queryParamsAllowlist: string[];
    networkBlocklist: string[];
    dom: Required<PrivacyDomConfig>;
  };
}

export const DEFAULT_CONFIG: ResolvedConfig = {
  errors: { enabled: true, sampleRate: 1.0 },
  breadcrumbs: {
    network: true,
    console: true,
    clicks: true,
    longTasks: true,
    scrollDepth: true,
  },
  session: { enabled: false, inactivityTimeoutMs: 1_800_000 },
  privacy: {
    queryParamsAllowlist: [],
    networkBlocklist: [],
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
    session: { ...d.session, ...input.session },
    privacy: {
      queryParamsAllowlist:
        input.privacy?.queryParamsAllowlist ?? d.privacy.queryParamsAllowlist,
      networkBlocklist:
        input.privacy?.networkBlocklist ?? d.privacy.networkBlocklist,
      dom: { ...d.privacy.dom, ...input.privacy?.dom },
    },
  };
}

/** Identity of the current user, set via `setUser`. Rides the session/journey
 * stream as `SessionContext.user_id`/`user_email`/`user_name`. For arbitrary
 * error-filtering metadata (plan, org, …) use `setTags` instead. */
export interface UserContext {
  id?: string;
  email?: string;
  name?: string;
}

/** Arbitrary string key-value annotations attached to error payloads, set via
 * `setTags`. These are the error `tags` map — filter/search errors by them in
 * the UI. The SDK skips empty values, coerces values to strings, and caps the
 * number of tags; the server truncates each value to 256 bytes. */
export type ErrorTags = Record<string, string>;

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
  /** Full session context, attached only when an `onErrorReported` subscriber
   * is registered to consume it (the error wire payload doesn't carry it, so
   * it's not computed otherwise). Present whenever a subscriber receives the
   * event. */
  session?: SessionContext;
  app_version?: string;
  suppressed_count?: number;
  context?: Record<string, unknown>;
}

/** Wire shape for errors POSTed to `/ingest/browser/errors`. Aligned with AppSignal's
 * Transaction schema. Kept separate from `BrowserError` because subscribers
 * (`onErrorReported`) still want the richer internal shape — only the
 * network format follows this. */
export interface FrontendTransaction {
  /** Unix seconds (not milliseconds). */
  timestamp: number;
  namespace: "browser";
  /** The current navigation's action, frozen at first use. See
   * `getRouteAction` in vitals.ts. */
  action: string;
  /** The trace this page load propagated in its `traceparent` headers, so the
   * error span joins the trace the backend spans are already in. Absent when
   * the page load propagated nothing, in which case the server generates one.
   * Both IDs are lowercase hex exactly as they appear in the header. */
  trace_id?: string;
  /** The page load span this error belongs to. Absent under the same condition
   * as `trace_id`. */
  span_id?: string;
  /** The navigation's start, epoch ms. Absent under the same condition as
   * `trace_id`. The server used to store the moment the error happened as the
   * span's bounds, which can be long after the page load; sending the real
   * start here lets the error row state an interval that actually belongs to
   * the span, so a union of rows' intervals is correct with no special case
   * for error rows. `timestamp` above still means the error's own time — this
   * is a separate field. */
  start_time?: number;
  /** Overrides the server's `"browser"` default for the span's service name.
   * See `BrowserConfig.serviceName`. */
  service_name?: string;
  /** Maps to `BrowserConfig.appVersion`. */
  revision?: string;
  error: {
    name: string;
    message: string;
    /** Stack lines, one per array entry. Empty when no stack was captured. */
    backtrace: string[];
  };
  breadcrumbs: TransactionBreadcrumb[];
  /** Host-supplied error tags from `setTags` (see `ErrorTags`). The SDK injects
   * no identity of its own — user identity rides the session stream, and
   * session/tab/anonymous ids aren't tags (high-cardinality, not in the
   * server's metadata-distribution allowlist). Empty `{}` when none set. */
  tags: ErrorTags;
  environment: {
    url: string;
  };
  user_agent: string;
}

/** Wire shape for a breadcrumb inside a FrontendTransaction.
 *
 * Differs from the internal `Breadcrumb` in three ways:
 * - timestamp in unix seconds (internal is ms)
 * - `action` is a category-specific identifier (selector for clicks, URL
 *   for navigation/network, etc.) — present even when empty
 * - `metadata` always present (defaults to `{}`) where internal `data` is
 *   optional */
export interface TransactionBreadcrumb {
  timestamp: number;
  category: string;
  action: string;
  message: string;
  metadata: Record<string, unknown>;
}

/** Web vital — both the in-memory shape the reporters collect (see `vitals.ts`)
 * and the wire shape sent inside an `events` payload to `/ingest/browser`.
 * Matches the processor's `VitalPayload` (browser/convert.rs) exactly: bare
 * metric `name` ("LCP", "CLS", ...), `value`, route, and epoch-ms `timestamp`.
 * Those four are the only fields the server deserializes; `rating` is derived
 * from `value` at query time and `element`/`interaction_type` have no store
 * yet, so none are sent here.
 *
 * `page_url` is the route the SDK attributes the metric to: the template the
 * host set via `setRouteTemplate` if any, otherwise the scrubbed raw URL. The
 * server runs `auto_template` either way — idempotent on templates, helpful on
 * raw URLs. */
export interface EventVital {
  name: string;
  value: number;
  page_url: string;
  timestamp: number;
}

/** The identity of one navigation's page load span. Every payload that
 * describes that span carries this triple — frozen once per navigation, so it
 * cannot disagree between posts — and the server folds the rows that share it
 * into a single span. */
export interface TraceContext {
  trace_id: string;
  span_id: string;
  /** Navigation start, epoch ms. The server clamps it against the time it
   * received the post. */
  start_time: number;
}

/** Wire shape POSTed to `/ingest/browser` on the first request of a navigation
 * that propagates a `traceparent`. It declares the page load span, so the
 * backend spans created from that header have a parent that exists. Sent on its
 * own rather than inside an `events` payload, because the events payload only
 * leaves at route and page boundaries — far too late for a span that is being
 * referred to now. */
export interface PageLoadPayload extends TraceContext {
  type: "page_load";
  /** The navigation's frozen action. This is the only payload that sets the
   * action on the page load span. */
  action: string;
  /** Maps to `BrowserConfig.appVersion`. Sent here too, alongside the events
   * payload, so a page load whose closing post never arrives still has a
   * revision to be found by. */
  app_version?: string;
  /** Overrides the server's `"browser"` default for the span's service name.
   * See `BrowserConfig.serviceName`. */
  service_name?: string;
  /** The host's error tags, from `setTags`. Previously these rode on error
   * payloads only, so a page load had tags if and only if something threw.
   * Sending them here too means every page load carries them regardless. */
  tags: ErrorTags;
}

/** Closes the page load span declared by a `PageLoadPayload`, riding along on
 * the `events` payload at a route or page boundary. Repeats the action and
 * start time the declaring post already sent, alongside its own end time.
 * Those two used to be left off deliberately, on the theory that only one
 * payload should ever set them. But the freeze already guarantees every
 * payload for one navigation agrees on them, so leaving them off just meant a
 * page load with no closing-post-only fallback: a lost `page_load` post left
 * a span with an end time and no action, which is excluded from the trace
 * locator and never matches a trace list filter. */
export interface EventsPageLoad extends TraceContext {
  action: string;
  /** Overrides the server's `"browser"` default for the span's service name.
   * See `BrowserConfig.serviceName`. */
  service_name?: string;
  /** Navigation end, epoch ms. Repeated posts for one navigation are fine: the
   * server keeps the latest. */
  end_time: number;
  /** Host tags as they stand at the boundary, from `setTags`.
   *
   * Repeated from the `page_load` post rather than assumed to have arrived with
   * it, for two reasons. A lost `page_load` post would otherwise leave a span
   * with no tags at all. And the host can call `setTags` after the page load
   * post has gone, so this is the only delivery that can carry those later
   * tags. The server unions the tags across every row for the span, so nothing
   * set at any point in the navigation is dropped. */
  tags: ErrorTags;
}

export interface EventPayload {
  type: "events";
  session: SessionContext;
  breadcrumbs: Breadcrumb[];
  vitals: EventVital[];
  app_version?: string;
  /** Present when this navigation declared a page load span. Absent when
   * `tracePropagationTargets` is not configured, or when the navigation
   * propagated no `traceparent`, because then there is no span to close. */
  page_load?: EventsPageLoad;
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
