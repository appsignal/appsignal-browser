import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  initErrors,
  destroyErrors,
  getLastErrorTimestamp,
  onErrorReported,
} from "./errors.js";
import * as transport from "./transport.js";
import * as breadcrumbs from "./breadcrumbs.js";
import * as session from "./session.js";
import type { Breadcrumb, FrontendTransaction, IncomingError } from "./types.js";

vi.mock("./transport.js", () => ({
  sendError: vi.fn(),
}));

vi.mock("./breadcrumbs.js", () => ({
  addBreadcrumb: vi.fn(),
  getErrorBreadcrumbs: vi.fn(() => []),
}));

vi.mock("./session.js", () => ({
  getSessionContext: vi.fn(() => ({
    session_id: "test-session",
    tab_id: "test-tab",
    anonymous_id: "test-anon",
    page_url: "http://localhost/",
    referrer: "",
    user_agent: "test",
    screen_width: 1920,
    screen_height: 1080,
    viewport_width: 1200,
    viewport_height: 800,
    language: "en",
    timezone: "UTC",
  })),
  getTags: vi.fn(() => ({})),
}));

const sendErrorMock = transport.sendError as ReturnType<typeof vi.fn>;
const addBreadcrumbMock = breadcrumbs.addBreadcrumb as ReturnType<typeof vi.fn>;
const getErrorBreadcrumbsMock = breadcrumbs.getErrorBreadcrumbs as ReturnType<typeof vi.fn>;
const getTagsMock = session.getTags as ReturnType<typeof vi.fn>;

function fireError(message: string, stack?: string): void {
  const event = new ErrorEvent("error", {
    message,
    filename: "test.js",
    lineno: 10,
    colno: 5,
    error: stack ? { stack } : undefined,
  });
  window.dispatchEvent(event);
}

describe("errors", () => {
  beforeEach(() => {
    // initErrors is idempotent — but explicitly tear down + clear mocks so
    // each test starts from zero and assertions can use direct counts.
    destroyErrors();
    sendErrorMock.mockClear();
    addBreadcrumbMock.mockClear();
    getErrorBreadcrumbsMock.mockReturnValue([]);
    getTagsMock.mockReturnValue({});
  });

  it("sends error events via transport", () => {
    initErrors({ enabled: true, sampleRate: 1.0 }, "v1.0");
    fireError("Test error");

    expect(sendErrorMock).toHaveBeenCalledTimes(1);
    const payload = sendErrorMock.mock.calls[0][0] as FrontendTransaction;
    expect(payload.namespace).toBe("browser");
    expect(payload.error.message).toBe("Test error");
    expect(payload.revision).toBe("v1.0");
    // No tags set → empty map. SDK identity (session/tab/anonymous ids) is
    // never sent as tags; tags carry only what the host set via setTags.
    expect(payload.tags).toEqual({});
    expect(payload.environment.url).toBe(location.href);
    expect(payload.user_agent).toBe(navigator.userAgent);
  });

  it("ships the host's error tags (from getTags) on the payload", () => {
    // setTags' coercion/cap happens in the session layer; errors carry the
    // resulting map verbatim.
    getTagsMock.mockReturnValue({ plan: "pro", org_id: "acme" });
    initErrors({ enabled: true, sampleRate: 1.0 });
    fireError("tagged error");

    const payload = sendErrorMock.mock.calls[0][0] as FrontendTransaction;
    expect(payload.tags).toEqual({ plan: "pro", org_id: "acme" });
  });

  it("captures error name from the Error constructor", () => {
    initErrors({ enabled: true, sampleRate: 1.0 });
    const err = new TypeError("Cannot read property 'name' of undefined");
    const event = new ErrorEvent("error", {
      message: err.message,
      filename: "app.js",
      lineno: 1,
      colno: 1,
      error: err,
    });
    window.dispatchEvent(event);

    expect(sendErrorMock).toHaveBeenCalledTimes(1);
    const payload = sendErrorMock.mock.calls[0][0] as FrontendTransaction;
    expect(payload.error.name).toBe("TypeError");
  });

  it("splits stack into backtrace lines, empty when no stack", () => {
    initErrors({ enabled: true, sampleRate: 1.0 });
    fireError("no stack here");

    const payload = sendErrorMock.mock.calls[0][0] as FrontendTransaction;
    expect(payload.error.backtrace).toEqual([]);

    sendErrorMock.mockClear();
    fireError("with stack", "Error: with stack\n    at a (a.js:1:1)\n    at b (b.js:2:2)");
    const withStack = sendErrorMock.mock.calls[0][0] as FrontendTransaction;
    expect(withStack.error.backtrace).toEqual([
      "Error: with stack",
      "    at a (a.js:1:1)",
      "    at b (b.js:2:2)",
    ]);
  });

  it("uses location.pathname for action and seconds-since-epoch for timestamp", () => {
    initErrors({ enabled: true, sampleRate: 1.0 });
    const before = Math.floor(Date.now() / 1000);
    fireError("shape check");
    const after = Math.floor(Date.now() / 1000);

    const payload = sendErrorMock.mock.calls[0][0] as FrontendTransaction;
    expect(payload.action).toBe(location.pathname);
    expect(payload.timestamp).toBeGreaterThanOrEqual(before);
    expect(payload.timestamp).toBeLessThanOrEqual(after);
  });

  it("does not send when disabled", () => {
    initErrors({ enabled: false, sampleRate: 1.0 });
    fireError("Test error");

    expect(sendErrorMock).not.toHaveBeenCalled();
  });

  it("repeated init does not stack listeners", () => {
    // Regression: a second initErrors used to leave the previous listener
    // attached, so a single dispatched error fired the pipeline twice.
    initErrors({ enabled: true, sampleRate: 1.0 });
    initErrors({ enabled: true, sampleRate: 1.0 });
    initErrors({ enabled: true, sampleRate: 1.0 });
    fireError("only once");

    expect(sendErrorMock).toHaveBeenCalledTimes(1);
  });

  describe("beforeError", () => {
    it("can modify the payload by mutating the incoming event", () => {
      const hook = vi.fn((event: IncomingError) => {
        event.message = "redacted";
        return event;
      });
      initErrors({ enabled: true, sampleRate: 1.0 }, undefined, hook);
      fireError("sensitive data");

      const payload = sendErrorMock.mock.calls[0][0] as FrontendTransaction;
      expect(payload.error.message).toBe("redacted");
    });

    it("can drop the event by returning null", () => {
      const hook = vi.fn(() => null);
      initErrors({ enabled: true, sampleRate: 1.0 }, undefined, hook);
      fireError("drop me");

      expect(hook).toHaveBeenCalled();
      expect(sendErrorMock).not.toHaveBeenCalled();
    });

    it("dropping skips the error breadcrumb (early-pipeline)", () => {
      // The defining property of beforeError vs the old late-pipeline
      // beforeSend: a dropped error must not pollute the breadcrumb buffer
      // with its own error breadcrumb.
      initErrors({ enabled: true, sampleRate: 1.0 }, undefined, () => null);
      fireError("never seen");

      const errorCrumbs = addBreadcrumbMock.mock.calls.filter(
        (c: unknown[]) => (c[0] as { category: string }).category === "error",
      );
      expect(errorCrumbs).toHaveLength(0);
    });

    it("dropping skips the lastErrorTimestamp update (early-pipeline)", () => {
      initErrors({ enabled: true, sampleRate: 1.0 }, undefined, () => null);
      const before = getLastErrorTimestamp();
      fireError("never seen");
      expect(getLastErrorTimestamp()).toBe(before);
    });

    it("supports common one-liner drop patterns (former ignoreErrors)", () => {
      const hook = (e: IncomingError): IncomingError | null =>
        /ResizeObserver/.test(e.message) ? null : e;
      initErrors({ enabled: true, sampleRate: 1.0 }, undefined, hook);

      fireError("ResizeObserver loop limit exceeded");
      expect(sendErrorMock).not.toHaveBeenCalled();

      fireError("TypeError: Cannot read property 'foo'");
      expect(sendErrorMock).toHaveBeenCalledTimes(1);
    });

    it("drops the event and logs when beforeError returns a Promise", () => {
      // beforeError is sync only. A Promise return would otherwise pass the
      // truthy check and the SDK would proceed treating the Promise as the
      // incoming event — silent breakage. The guard turns that into a loud,
      // droppable failure.
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const hook = vi.fn((event: IncomingError) => Promise.resolve(event)) as unknown as
        (event: IncomingError) => IncomingError | null;
      initErrors({ enabled: true, sampleRate: 1.0 }, undefined, hook);

      fireError("async hook");

      expect(sendErrorMock).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy.mock.calls[0][0]).toContain("beforeError returned a Promise");

      consoleErrorSpy.mockRestore();
    });
  });

  describe("deduplication", () => {
    it("suppresses repeated identical errors after 5 occurrences", () => {
      initErrors({ enabled: true, sampleRate: 1.0 });

      for (let i = 0; i < 10; i++) {
        fireError("dedup test error");
      }

      // First 5 should be sent, 6-10 suppressed
      expect(sendErrorMock).toHaveBeenCalledTimes(5);
    });
  });

  describe("sample rate", () => {
    it("drops errors when sampleRate is 0", () => {
      initErrors({ enabled: true, sampleRate: 0 });
      fireError("should be dropped");

      expect(sendErrorMock).not.toHaveBeenCalled();
    });
  });

  it("updates lastErrorTimestamp", () => {
    const before = Date.now();
    initErrors({ enabled: true, sampleRate: 1.0 });
    fireError("timestamp test");
    const after = Date.now();

    const ts = getLastErrorTimestamp();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("notifies onErrorReported subscribers after the error has shipped", () => {
    initErrors({ enabled: true, sampleRate: 1.0 });
    const subscriber = vi.fn();
    onErrorReported(subscriber);

    fireError("subscriber test");

    expect(subscriber).toHaveBeenCalledTimes(1);
    // Subscribers still receive the internal BrowserError shape — it has
    // breadcrumbs and full session context that the wire FrontendTransaction
    // drops. The wire format is an implementation detail of transport.
    const event = subscriber.mock.calls[0][0];
    expect(event.message).toBe("subscriber test");
    // Session context is computed lazily, but a registered subscriber must
    // still receive it.
    expect(event.session?.session_id).toBe("test-session");
  });

  it("does not notify subscribers when beforeError drops the error", () => {
    initErrors(
      { enabled: true, sampleRate: 1.0 },
      undefined,
      () => null,
    );
    const subscriber = vi.fn();
    onErrorReported(subscriber);

    fireError("dropped by beforeError");

    expect(sendErrorMock).not.toHaveBeenCalled();
    expect(subscriber).not.toHaveBeenCalled();
  });

  it("adds error breadcrumb", () => {
    initErrors({ enabled: true, sampleRate: 1.0 });
    fireError("breadcrumb test error");

    const errorBreadcrumb = addBreadcrumbMock.mock.calls.find(
      (call: unknown[]) => (call[0] as { category: string }).category === "error",
    );
    expect(errorBreadcrumb).toBeTruthy();
    expect(errorBreadcrumb![0].message).toContain("breadcrumb test error");
  });

  describe("breadcrumb mapping into the FrontendTransaction wire shape", () => {
    function captureSentBreadcrumbs(): FrontendTransaction["breadcrumbs"] {
      return (sendErrorMock.mock.calls[0][0] as FrontendTransaction).breadcrumbs;
    }

    it("ships an empty breadcrumbs array when the buffer is empty", () => {
      getErrorBreadcrumbsMock.mockReturnValue([]);
      initErrors({ enabled: true, sampleRate: 1.0 });
      fireError("empty buffer");

      const sent = captureSentBreadcrumbs();
      expect(sent).toEqual([]);
    });

    it("derives a network breadcrumb's action from data.url", () => {
      const crumb: Breadcrumb = {
        timestamp: 1747756799_000,
        category: "network",
        message: "POST 500 https://api.example.com/cart/items",
        data: { method: "POST", url: "https://api.example.com/cart/items", status: 500, duration_ms: 230 },
      };
      getErrorBreadcrumbsMock.mockReturnValue([crumb]);
      initErrors({ enabled: true, sampleRate: 1.0 });
      fireError("with network crumb");

      const sent = captureSentBreadcrumbs();
      expect(sent[0]).toEqual({
        timestamp: 1747756799,
        category: "network",
        action: "https://api.example.com/cart/items",
        message: "POST 500 https://api.example.com/cart/items",
        metadata: crumb.data,
      });
    });

    it("derives action per category (navigation, click, console, visibility)", () => {
      const crumbs: Breadcrumb[] = [
        {
          timestamp: 1747756795_000, category: "navigation",
          message: "navigated to /products",
          data: { from: "/", to: "/products" },
        },
        {
          timestamp: 1747756798_000, category: "click",
          message: 'clicked "Add to cart"',
          data: { selector: "button#add-to-cart", text: "Add to cart" },
        },
        {
          timestamp: 1747756799_000, category: "console",
          message: "[warn] retrying",
          data: { level: "warn" },
        },
        {
          timestamp: 1747756800_000, category: "visibility",
          message: "hidden",
          data: { state: "hidden" },
        },
      ];
      getErrorBreadcrumbsMock.mockReturnValue(crumbs);
      initErrors({ enabled: true, sampleRate: 1.0 });
      fireError("derive actions");

      const sent = captureSentBreadcrumbs();
      expect(sent.map((b) => b.action)).toEqual([
        "/products",       // navigation.data.to
        "button#add-to-cart",
        "warn",
        "hidden",
      ]);
    });

    it("defaults metadata to {} when the breadcrumb has no data", () => {
      const crumb: Breadcrumb = {
        timestamp: 1747756800_000, category: "error",
        message: "Test error",
      };
      getErrorBreadcrumbsMock.mockReturnValue([crumb]);
      initErrors({ enabled: true, sampleRate: 1.0 });
      fireError("metadata default");

      const sent = captureSentBreadcrumbs();
      expect(sent[0].metadata).toEqual({});
      // Categories with no obvious primary identifier get "" — present but
      // empty, never undefined.
      expect(sent[0].action).toBe("");
    });

    it("converts breadcrumb timestamps from ms to unix seconds", () => {
      getErrorBreadcrumbsMock.mockReturnValue([
        { timestamp: 1747756799_500, category: "click", message: "x", data: { selector: "a" } },
      ]);
      initErrors({ enabled: true, sampleRate: 1.0 });
      fireError("timestamp");

      expect(captureSentBreadcrumbs()[0].timestamp).toBe(1747756799);
    });
  });
});
