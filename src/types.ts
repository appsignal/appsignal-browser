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
  breadcrumbs: {
    enabled: boolean;
    network: boolean;
    network_blocklist: string[];
    query_params_allowlist: string[];
    network_payloads: {
      enabled: boolean;
      request_body: boolean;
      response_body: boolean;
      max_size_bytes: number;
      content_types: string[];
    };
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
    /** How long the post-error ship window stays open after each error.
     * Each new error within the window slides it forward. */
    error_replay_window_ms: number;
    mask_all_inputs: boolean;
    mask_selectors: string[];
    block_selectors: string[];
    max_duration_ms: number;
    checkout_interval_ms: number;
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
  breadcrumbs: {
    enabled: true,
    network: true,
    network_blocklist: [],
    query_params_allowlist: [],
    network_payloads: {
      enabled: false,
      request_body: true,
      response_body: true,
      max_size_bytes: 65536,
      content_types: ["application/json", "text/plain", "text/html"],
    },
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
    error_replay_window_ms: 30_000,
    mask_all_inputs: true,
    mask_selectors: [],
    block_selectors: [],
    max_duration_ms: 14_400_000, // 4 hours
    checkout_interval_ms: 60_000, // 1 minute
  },
  session: { inactivity_timeout_ms: 1_800_000 },
};
