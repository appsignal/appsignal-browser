// HTTP test fixture for E2E. Serves the sample-app pages, the built SDK,
// mocks the ingest endpoints, and exposes /__captured + /__reset so tests
// can inspect what the SDK actually sent. One instance per Playwright
// worker (see e2e/fixtures.ts); tests poll the capture endpoint to wait
// for events to arrive.

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { readFile } from "fs/promises";
import { resolve, extname, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

type Captured =
  | { kind: "ingest"; path: string; query: Record<string, string>; body: string; receivedAt: number }
  | {
      kind: "api";
      method: string;
      path: string;
      query: Record<string, string>;
      headers: Record<string, string | undefined>;
      body: string;
      receivedAt: number;
    };

let captured: Captured[] = [];

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
};

async function serveStatic(filePath: string, res: ServerResponse): Promise<void> {
  try {
    const data = await readFile(filePath);
    const type = MIME[extname(filePath)] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end(`Not Found: ${filePath}`);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const pathname = url.pathname;
  const query = Object.fromEntries(url.searchParams);

  // Permissive CORS — tests fetch from the same origin anyway, but the
  // SDK's instrumented fetch may target /api/* from /sample/*; same-origin.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, traceparent");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── Test-only inspection ───────────────────────────────────────────────
  if (pathname === "/__captured" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(captured));
    return;
  }
  if (pathname === "/__reset" && req.method === "POST") {
    captured = [];
    res.writeHead(204);
    res.end();
    return;
  }

  // ── SDK ingest (mock) ──────────────────────────────────────────────────
  // Routes the v1 SDK targets:
  //  - /ingest/browser         (events: breadcrumbs + vitals, replay later)
  //  - /ingest/browser/errors  (errors as FrontendTransaction)
  // Legacy paths (/collect, /metrics/webvitals) are still captured for the
  // old @appsignal/javascript SDK. All captured under kind="ingest"; helpers
  // disambiguate by path.
  if (
    req.method === "POST" &&
    (pathname === "/ingest/browser" ||
      pathname === "/ingest/browser/errors" ||
      pathname === "/collect" ||
      pathname === "/metrics/webvitals")
  ) {
    const body = await readBody(req);
    captured.push({
      kind: "ingest",
      path: pathname,
      query,
      body,
      receivedAt: Date.now(),
    });
    res.writeHead(200);
    res.end();
    return;
  }

  // ── Test API endpoints ─────────────────────────────────────────────────
  // /api/echo[?status=NNN] — captures method, headers, body. Used to verify
  // the SDK's instrumented fetch (network breadcrumbs, traceparent injection).
  if (pathname.startsWith("/api/")) {
    const body = req.method === "POST" || req.method === "PUT" ? await readBody(req) : "";
    captured.push({
      kind: "api",
      method: req.method ?? "GET",
      path: pathname,
      query,
      headers: {
        traceparent: req.headers.traceparent as string | undefined,
        "content-type": req.headers["content-type"] as string | undefined,
      },
      body,
      receivedAt: Date.now(),
    });
    const status = query.status ? Number(query.status) : 200;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: status < 400 }));
    return;
  }

  // ── Static files ───────────────────────────────────────────────────────
  if (pathname === "/") {
    await serveStatic(resolve(root, "e2e/sample-app/index.html"), res);
    return;
  }
  // Serve any sample-app HTML page by basename, e.g. /pii-redaction.html.
  // The path-traversal guard keeps callers inside e2e/sample-app/.
  if (pathname.endsWith(".html") && !pathname.includes("..")) {
    await serveStatic(resolve(root, "e2e/sample-app" + pathname), res);
    return;
  }
  if (pathname.startsWith("/dist/")) {
    await serveStatic(resolve(root, pathname.slice(1)), res);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

const port = Number(process.env.E2E_PORT ?? 3210);
server.listen(port, () => {
  console.log(`E2E server listening on http://localhost:${port}`);
});
