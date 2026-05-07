import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/tests",
  // Serial: the test server's /__captured state is shared across the whole
  // process. Parallel workers would clobber each other's reset/poll cycle.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:3210",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun run e2e/server.ts",
    // Probe an endpoint Playwright can poll. /__captured returns 200 + JSON
    // once the server is up and is fast enough that startup is unambiguous.
    url: "http://localhost:3210/__captured",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    stdout: "pipe",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
