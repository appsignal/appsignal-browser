// Per-worker server fixture. Each Playwright worker spawns its own copy of
// e2e/server.ts on a unique port, so /__captured and /__config state is
// isolated across parallel workers. Tests within one worker still share a
// server, so file-level serial execution remains (fullyParallel: false).

import { test as base } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

type WorkerFixtures = {
  serverUrl: string;
  // A second instance on its own port. The ingest is a different origin in
  // every real install, and some faults only happen cross-origin.
  ingestUrl: string;
};

async function waitForReady(url: string, deadlineMs: number): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < deadlineMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (e) {
      lastErr = e;
    }
    await sleep(100);
  }
  throw new Error(
    `Server at ${url} did not become ready within ${deadlineMs}ms: ${String(lastErr)}`,
  );
}

function waitForExit(proc: ChildProcess, graceMs: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, graceMs);
    proc.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

async function withServer(
  port: number,
  workerIndex: number,
  label: string,
  use: (url: string) => Promise<void>,
): Promise<void> {
  const proc = spawn("bun", ["run", "e2e/server.ts"], {
    env: { ...process.env, E2E_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const prefix = `[${label}:${workerIndex}] `;
  proc.stdout?.on("data", (d: Buffer) => process.stderr.write(prefix + d.toString()));
  proc.stderr?.on("data", (d: Buffer) => process.stderr.write(prefix + d.toString()));

  try {
    await waitForReady(`http://localhost:${port}/__captured`, 30_000);
    await use(`http://localhost:${port}`);
  } finally {
    proc.kill("SIGTERM");
    await waitForExit(proc, 2_000);
  }
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export const test = base.extend<{}, WorkerFixtures>({
  serverUrl: [
    async ({}, use, workerInfo) => {
      await withServer(3210 + workerInfo.workerIndex, workerInfo.workerIndex, "server", use);
    },
    { scope: "worker" },
  ],

  ingestUrl: [
    async ({}, use, workerInfo) => {
      await withServer(3310 + workerInfo.workerIndex, workerInfo.workerIndex, "ingest", use);
    },
    { scope: "worker" },
  ],

  baseURL: async ({ serverUrl }, use) => {
    await use(serverUrl);
  },
});

export { expect } from "@playwright/test";
export type { APIRequestContext, Page } from "@playwright/test";
