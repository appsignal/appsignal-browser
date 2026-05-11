import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/tests",
  // Worker isolation comes from the serverUrl fixture in e2e/fixtures.ts:
  // each worker spawns its own e2e/server.ts on port 3210 + workerIndex, so
  // files run in parallel across workers. fullyParallel stays false so tests
  // inside one file remain serial against their shared per-worker server.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
