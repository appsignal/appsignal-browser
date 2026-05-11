import type { ConsentState } from "./consent.js";

/** Client-side configuration — only the ingestion key is required. */
export interface BrowserConfig {
  key: string;
  endpoint?: string;
  appVersion?: string;
  user?: UserContext;
  /** Modify or drop error events before sending. Return null to drop. */
  beforeSend?: (event: BrowserError) => BrowserError | null;
  /** Error message patterns to ignore. Matching errors are silently dropped. */
  ignoreErrors?: (string | RegExp)[];
  /** URL patterns to inject trace context headers into. Glob syntax. */
  tracePropagationTargets?: string[];
  /** Initial tracking consent state. Default: "granted" (backwards compatible). */
  trackingConsent?: ConsentState;
}

export interface UserContext {
  id?: string;
  email?: string;
  name?: string;
}

/** Server-side config fetched on init. */
export interface ServerConfig {
  enabled: boolean;
  errors: { enabled: boolean; sample_rate: number };
  /** Cross-cutting privacy controls. Each knob lists the subsystems that
   * consume it; if no subsystem applies (e.g. error messages, console args,
   * network bodies) the knob has no effect there. Channel-specific knobs
   * (e.g. `breadcrumbs.network_payloads`) stay in their feature namespace. */
  privacy: {
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
    query_params_allowlist: string[];
    /** DOM-derived captures only. Selectors are CSS selectors evaluated
     * against live DOM nodes; they have no effect on data that isn't sourced
     * from an element (error messages, console args, network bodies). */
    dom: {
      /** CSS selectors whose **text content** is masked. The element itself,
       * its structure, and its non-text attributes are still recorded —
       * only the visible text is replaced.
       *
       * Applied to:
       *  - session replay (rrweb `maskTextSelector`: text → `*`)
       *  - click breadcrumb text content (→ `"[masked]"`) when the click
       *    target matches or descends from a listed selector */
      mask_text: string[];
      /** CSS selectors whose **elements are entirely excluded** from capture.
       * The element and its subtree are never recorded.
       *
       * Applied to:
       *  - session replay (rrweb `blockSelector`: subtree → placeholder)
       *  - click breadcrumbs (the breadcrumb — and any rage/dead/error
       *    click derived from it — is suppressed when the click target
       *    matches or descends from a listed selector) */
      block_element: string[];
    };
  };
  breadcrumbs: {
    enabled: boolean;
    network: boolean;
    network_blocklist: string[];
    console: boolean;
    clicks: boolean;
    long_tasks: boolean;
    scroll_depth: boolean;
    form_abandonment: boolean;
    user_timing: boolean;
    capacity: number;
  };
  web_vitals: { enabled: boolean };
  replay: {
    enabled: boolean;
    sample_rate: number;
    error_replay: boolean;
    /** Replay-specific: rrweb's `maskAllInputs` masks every form-field value
     * as `***` regardless of selector. Not a cross-cutting concern (only
     * rrweb knows what an "input" is in its serialised event stream), so
     * stays here rather than under `privacy.dom`. */
    mask_all_inputs: boolean;
    max_duration_ms: number;
  };
  session: { inactivity_timeout_ms: number };
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

export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  enabled: true,
  errors: { enabled: true, sample_rate: 1.0 },
  privacy: {
    query_params_allowlist: [],
    dom: {
      mask_text: [],
      block_element: [],
    },
  },
  breadcrumbs: {
    enabled: true,
    network: true,
    network_blocklist: [],
    console: true,
    clicks: true,
    long_tasks: true,
    scroll_depth: true,
    form_abandonment: true,
    // Off by default — heavy developer instrumentation can flood the ring
    // buffer. Matches the server-side default in crates/config/src/browser.rs.
    user_timing: false,
    capacity: 100,
  },
  web_vitals: { enabled: true },
  replay: {
    enabled: true,
    sample_rate: 1.0,
    error_replay: true,
    mask_all_inputs: true,
    max_duration_ms: 14_400_000, // 4 hours
  },
  session: { inactivity_timeout_ms: 1_800_000 },
};
