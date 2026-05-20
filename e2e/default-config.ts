// Reference server config payload, preserved alongside the (currently
// skipped) replay/error-replay e2e specs. v1 does not ship server-side
// config, so this object is not used by any active test. When replay
// returns and the specs are re-enabled, this shape lines back up with
// whatever future config-delivery path is in place.

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
