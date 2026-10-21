// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { emitAppState, appStateListenerCount } from "./testing/reactNative.js";
import type { FrontendTransaction } from "../types.js";
import * as sdk from "./index.js";

type GlobalHandler = (error: unknown, isFatal?: boolean) => void;

const KEY = "rn-key";
const ENDPOINT = "https://collector.test";

let fetchMock: ReturnType<typeof vi.fn>;
let reactNativeHandler: ReturnType<typeof vi.fn>;
let globalHandler: GlobalHandler;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

class FakeXMLHttpRequest {
  open(): void {}
  send(): void {}
  abort(): void {}
  setRequestHeader(): void {}
}

function sentErrors(): FrontendTransaction[] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).includes("/ingest/browser/errors"))
    .map(([, options]) => JSON.parse((options as { body: string }).body) as FrontendTransaction);
}

beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve(new Response("", { status: 200 })));
  reactNativeHandler = vi.fn();
  globalHandler = reactNativeHandler;
  // React Native aliases `window` to the global object and has no document.
  Object.assign(globalThis, {
    window: globalThis,
    fetch: fetchMock,
    XMLHttpRequest: FakeXMLHttpRequest,
    ErrorUtils: {
      getGlobalHandler: () => globalHandler,
      setGlobalHandler: (handler: GlobalHandler) => { globalHandler = handler; },
    },
  });
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  sdk.destroy();
  vi.restoreAllMocks();
  for (const name of ["window", "XMLHttpRequest", "ErrorUtils"]) {
    delete (globalThis as Record<string, unknown>)[name];
  }
});

describe("react-native entry point", () => {
  it("starts without a document and reports a captured error", () => {
    sdk.init({ key: KEY, endpoint: ENDPOINT, appVersion: "1.2.3" });

    expect(consoleErrorSpy).not.toHaveBeenCalled();

    sdk.setRouteTemplate("Home");
    sdk.setTags({ plan: "pro" });
    sdk.addBreadcrumb({ category: "test", message: "hello" });
    sdk.captureError(new Error("boom"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${ENDPOINT}/ingest/browser/errors?api_key=${KEY}`);
    const [payload] = sentErrors();
    expect(payload.namespace).toBe("browser");
    expect(payload.action).toBe("Home");
    expect(payload.revision).toBe("1.2.3");
    expect(payload.service_name).toBe("React Native");
    expect(payload.user_agent).toBe("react-native ios 27.1");
    expect(payload.environment.url).toBe("");
    expect(payload.error.name).toBe("Error");
    expect(payload.error.message).toBe("boom");
    expect(payload.tags).toEqual({ plan: "pro" });
    expect(payload.breadcrumbs.map((b) => b.message)).toContain("hello");
  });

  it("sends to the AppSignal endpoint when none is given", () => {
    sdk.init({ key: KEY });
    sdk.captureError(new Error("boom"));

    expect(fetchMock.mock.calls[0][0]).toBe(`https://appsignal-endpoint.net/ingest/browser/errors?api_key=${KEY}`);
  });

  it("reports an uncaught error through ErrorUtils and keeps React Native's handler", () => {
    sdk.init({ key: KEY, endpoint: ENDPOINT });
    const error = new TypeError("uncaught");

    globalHandler(error, true);

    const [payload] = sentErrors();
    expect(payload.error.name).toBe("TypeError");
    expect(payload.error.message).toBe("uncaught");
    expect(reactNativeHandler).toHaveBeenCalledWith(error, true);

    sdk.destroy();
    expect(globalHandler).toBe(reactNativeHandler);
  });

  it("records a request as a network breadcrumb", async () => {
    sdk.init({ key: KEY, endpoint: ENDPOINT });

    await fetch("https://api.test/items");
    sdk.captureError(new Error("after request"));

    const [payload] = sentErrors();
    const network = payload.breadcrumbs.find((b) => b.category === "network");
    expect(network?.action).toBe("https://api.test/items");
  });

  it("records the app going to the background and stops listening on destroy", () => {
    sdk.init({ key: KEY, endpoint: ENDPOINT });

    emitAppState("background");
    sdk.captureError(new Error("in background"));

    const [payload] = sentErrors();
    const visibility = payload.breadcrumbs.find((b) => b.category === "visibility");
    expect(visibility?.metadata).toEqual({ state: "hidden" });

    sdk.destroy();
    expect(appStateListenerCount()).toBe(0);
  });

  it("propagates a trace to a matching request and reports its 5xx answer", async () => {
    sdk.init({ key: KEY, endpoint: ENDPOINT, tracePropagationTargets: ["api.test/**"] });
    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response("", { status: 503 })));

    await fetch("https://api.test/items", { headers: { Accept: "application/json" } });

    const [, options] = fetchMock.mock.calls[0];
    const traceparent = new Headers((options as RequestInit).headers).get("traceparent");
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const [payload] = sentErrors();
    expect(payload.error.name).toBe("HTTPError");
    expect(payload.error.message).toBe("GET https://api.test/items: HTTP 503");
    expect(payload.trace_id).toBe(traceparent?.split("-")[1]);
    expect(payload.span_id).toBe(traceparent?.split("-")[2]);
  });

  it("does nothing while inactive", () => {
    sdk.init({ key: KEY, endpoint: ENDPOINT, active: false });
    sdk.captureError(new Error("boom"));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(globalHandler).toBe(reactNativeHandler);
  });
});
