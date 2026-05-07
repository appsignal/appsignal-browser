import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    // Vitest's default include glob picks up `**/*.spec.ts`, which sweeps in
    // the Playwright tests under e2e/. Those use @playwright/test's
    // test.beforeEach and crash if run by vitest. Run them via `bun run
    // test:e2e` instead.
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
  },
});
