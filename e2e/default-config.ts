// Default server config payload. Mirrors src/types.ts DEFAULT_SERVER_CONFIG
// so e2e/server.ts and the test specs stay in lockstep with the SDK shape.
// Returns a fresh object each call so callers can mutate freely.

export function defaultConfig(): Record<string, unknown> {
  return {
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
      user_timing: false,
      capacity: 100,
    },
    web_vitals: { enabled: true },
    replay: {
      enabled: true,
      sample_rate: 1.0,
      error_replay: true,
      mask_all_inputs: true,
      max_duration_ms: 14_400_000,
    },
    session: { inactivity_timeout_ms: 1_800_000 },
  };
}
