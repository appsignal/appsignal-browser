import { safeUrl, matchesUrl, randomBytes, toHex } from "./utils.js";
import { onBeforeRequest, type PropagatedTrace, type RequestResult } from "./network-hook.js";
import { DEFAULT_SERVICE_NAME } from "./types.js";
import { currentRoute } from "./vitals.js";

// A tracestate value holds only printable ASCII without `,` or `=`, and the
// backend splits our value into fields on `;`.
const TRACESTATE_UNSAFE_CHARACTERS = /[^\x20-\x7E]|[,=;]/g;
const TRACESTATE_MAX_VALUE_LENGTH = 256;

let targets: string[] = [];
let unregisters: (() => void)[] = [];

export function initTracing(
  tracePropagationTargets: string[],
  serviceName: string = DEFAULT_SERVICE_NAME,
): void {
  destroyTracing();
  targets = tracePropagationTargets;
  if (targets.length === 0) return;
  const service = tracestateField(serviceName);

  unregisters.push(onBeforeRequest((ctx) => {
    if (!shouldPropagate(ctx.url)) return;
    const caller = parseTraceparent(ctx.headers.get("traceparent"));
    if (caller) {
      // The caller propagates its own context. Join that trace rather than
      // start a rival one, and report the ids that actually go on the wire.
      ctx.trace = caller;
      return;
    }
    const traceId = randomHex(16);
    const spanId = randomHex(8);
    ctx.headers.set("traceparent", `00-${traceId}-${spanId}-01`);
    // The SDK does not report a span for each request, so the backend often
    // sees a parent span that it never receives. The service name and the
    // route in tracestate tell the backend who that caller was. The route is
    // read on each request, because a single-page app changes it without a
    // page load.
    const value = `service:${service};action:${tracestateField(currentRoute())}`;
    const member = `appsignal=${value.slice(0, TRACESTATE_MAX_VALUE_LENGTH).trimEnd()}`;
    ctx.headers.set("tracestate", prependTracestateMember(ctx.headers.get("tracestate"), member));
    // Kept on the request itself, so whatever reads it later gets the ids of
    // that request and not of another one to the same URL.
    ctx.trace = { traceId, spanId };
  }));
}

function tracestateField(text: string): string {
  return text.replace(TRACESTATE_UNSAFE_CHARACTERS, "_");
}

/** Puts our member first, as the spec asks of the vendor that last changed the
 * trace, and keeps the members other vendors set. */
function prependTracestateMember(existing: string | null, member: string): string {
  const others = (existing ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry && !entry.startsWith("appsignal="));
  return [member, ...others].join(",");
}

/** The ids of a W3C `traceparent` the caller set, when it is one we can join.
 * An all-zero id is invalid per the spec and names no span. */
function parseTraceparent(value: string | null): PropagatedTrace | undefined {
  if (!value) return undefined;
  const parts = value.trim().match(/^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/);
  if (!parts) return undefined;
  const [, version, traceId, spanId, , extension] = parts;
  if (version === "ff" || (version === "00" && extension !== undefined)) return undefined;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined;
  return { traceId, spanId };
}

/** The trace ID a request propagated, or undefined when it propagated none.
 * It comes from the request itself, so two requests to one URL that answer in
 * either order each report their own. */
export function traceIdForRequest(result: RequestResult): string | undefined {
  return result.trace?.traceId;
}

export function destroyTracing(): void {
  for (const unregister of unregisters) unregister();
  unregisters = [];
  targets = [];
}

function shouldPropagate(url: string): boolean {
  const parsed = safeUrl(url);
  if (!parsed) return false;
  return targets.some((pattern) => matchesUrl(pattern, parsed));
}

/** N random bytes encoded as a lowercase hex string. Used for both the
 * 128-bit trace_id and the 64-bit span_id of the W3C traceparent header. */
function randomHex(numBytes: number): string {
  return toHex(randomBytes(numBytes));
}
