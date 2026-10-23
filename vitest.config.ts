import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  define: { __APPSIGNAL_BROWSER_VERSION__: JSON.stringify(version) },
  test: {
    environment: "jsdom",
    // Vitest's default include glob picks up `**/*.spec.ts`, which sweeps in
    // the Playwright tests under e2e/. Those use @playwright/test's
    // test.beforeEach and crash if run by vitest. Run them via `bun run
    // test:e2e` instead.
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
  },
});
