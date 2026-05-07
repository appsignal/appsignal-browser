// HTTP test fixture for E2E. Serves the sample page, the built SDK, mocks
// the ingest endpoints, and exposes /__captured + /__reset so tests can
// inspect what the SDK actually sent. One process; tests poll the capture
// endpoint to wait for events to arrive.

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
let configResponse: unknown = null;

function defaultConfig(): unknown {
  // Mirrors DEFAULT_SERVER_CONFIG; explicit so tests can see what they get.
  return {
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
      max_duration_ms: 14_400_000,
      checkout_interval_ms: 60_000,
    },
    session: { inactivity_timeout_ms: 1_800_000 },
  };
}
configResponse = defaultConfig();

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
    configResponse = defaultConfig();
    res.writeHead(204);
    res.end();
    return;
  }
  if (pathname === "/__config" && req.method === "POST") {
    configResponse = JSON.parse(await readBody(req));
    res.writeHead(204);
    res.end();
    return;
  }

  // ── SDK ingest (mock) ──────────────────────────────────────────────────
  if (pathname === "/ingest/browser/config" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(configResponse));
    return;
  }
  if (pathname === "/ingest/browser" && req.method === "POST") {
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
  if (pathname === "/" || pathname === "/index.html") {
    await serveStatic(resolve(root, "e2e/sample-app/index.html"), res);
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
