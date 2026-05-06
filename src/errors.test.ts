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
import type { BrowserError } from "./types.js";

vi.mock("./transport.js", () => ({
  sendError: vi.fn(),
}));

vi.mock("./breadcrumbs.js", () => ({
  addBreadcrumb: vi.fn(),
  getSnapshot: vi.fn(() => []),
}));

vi.mock("./session.js", () => ({
  getSessionContext: vi.fn(() => ({
    session_id: "test-session",
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
}));

const sendErrorMock = transport.sendError as ReturnType<typeof vi.fn>;
const addBreadcrumbMock = breadcrumbs.addBreadcrumb as ReturnType<typeof vi.fn>;

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
  });

  it("sends error events via transport", () => {
    initErrors({ enabled: true, sample_rate: 1.0 }, "v1.0");
    fireError("Test error");

    expect(sendErrorMock).toHaveBeenCalledTimes(1);
    const payload = sendErrorMock.mock.calls[0][0] as BrowserError;
    expect(payload.message).toBe("Test error");
    expect(payload.app_version).toBe("v1.0");
  });

  it("captures error_class from the Error constructor name", () => {
    initErrors({ enabled: true, sample_rate: 1.0 });
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
    const payload = sendErrorMock.mock.calls[0][0] as BrowserError;
    expect(payload.error_class).toBe("TypeError");
  });

  it("does not send when disabled", () => {
    initErrors({ enabled: false, sample_rate: 1.0 });
    fireError("Test error");

    expect(sendErrorMock).not.toHaveBeenCalled();
  });

  it("repeated init does not stack listeners", () => {
    // Regression: a second initErrors used to leave the previous listener
    // attached, so a single dispatched error fired the pipeline twice.
    initErrors({ enabled: true, sample_rate: 1.0 });
    initErrors({ enabled: true, sample_rate: 1.0 });
    initErrors({ enabled: true, sample_rate: 1.0 });
    fireError("only once");

    expect(sendErrorMock).toHaveBeenCalledTimes(1);
  });

  describe("ignoreErrors", () => {
    it("filters by string substring match", () => {
      initErrors({ enabled: true, sample_rate: 1.0 }, undefined, undefined, [
        "ResizeObserver loop",
      ]);
      fireError("ResizeObserver loop limit exceeded");

      expect(sendErrorMock).not.toHaveBeenCalled();
    });

    it("filters by regex match", () => {
      initErrors({ enabled: true, sample_rate: 1.0 }, undefined, undefined, [
        /Script error\.?/,
      ]);
      fireError("Script error.");

      expect(sendErrorMock).not.toHaveBeenCalled();
    });

    it("sends non-matching errors", () => {
      initErrors({ enabled: true, sample_rate: 1.0 }, undefined, undefined, [
        "ResizeObserver",
      ]);
      fireError("TypeError: Cannot read property 'foo'");

      expect(sendErrorMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("beforeSend", () => {
    it("can modify the payload", () => {
      const hook = vi.fn((event: BrowserError) => {
        event.message = "redacted";
        return event;
      });
      initErrors({ enabled: true, sample_rate: 1.0 }, undefined, hook);
      fireError("sensitive data");

      const payload = sendErrorMock.mock.calls[0][0] as BrowserError;
      expect(payload.message).toBe("redacted");
    });

    it("can drop the event by returning null", () => {
      const hook = vi.fn(() => null);
      initErrors({ enabled: true, sample_rate: 1.0 }, undefined, hook);
      fireError("drop me");

      expect(hook).toHaveBeenCalled();
      expect(sendErrorMock).not.toHaveBeenCalled();
    });
  });

  describe("deduplication", () => {
    it("suppresses repeated identical errors after 5 occurrences", () => {
      initErrors({ enabled: true, sample_rate: 1.0 });

      for (let i = 0; i < 10; i++) {
        fireError("dedup test error");
      }

      // First 5 should be sent, 6-10 suppressed
      expect(sendErrorMock).toHaveBeenCalledTimes(5);
    });
  });

  describe("sample rate", () => {
    it("drops errors when sample_rate is 0", () => {
      initErrors({ enabled: true, sample_rate: 0 });
      fireError("should be dropped");

      expect(sendErrorMock).not.toHaveBeenCalled();
    });
  });

  it("updates lastErrorTimestamp", () => {
    const before = Date.now();
    initErrors({ enabled: true, sample_rate: 1.0 });
    fireError("timestamp test");
    const after = Date.now();

    const ts = getLastErrorTimestamp();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("notifies onErrorReported subscribers after the error has shipped", () => {
    initErrors({ enabled: true, sample_rate: 1.0 });
    const subscriber = vi.fn();
    onErrorReported(subscriber);

    fireError("subscriber test");

    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(subscriber.mock.calls[0][0].message).toBe("subscriber test");
  });

  it("does not notify subscribers when beforeSend drops the error", () => {
    initErrors(
      { enabled: true, sample_rate: 1.0 },
      undefined,
      () => null,
    );
    const subscriber = vi.fn();
    onErrorReported(subscriber);

    fireError("dropped by beforeSend");

    expect(sendErrorMock).not.toHaveBeenCalled();
    expect(subscriber).not.toHaveBeenCalled();
  });

  it("adds error breadcrumb", () => {
    initErrors({ enabled: true, sample_rate: 1.0 });
    fireError("breadcrumb test error");

    const errorBreadcrumb = addBreadcrumbMock.mock.calls.find(
      (call: unknown[]) => (call[0] as { category: string }).category === "error",
    );
    expect(errorBreadcrumb).toBeTruthy();
    expect(errorBreadcrumb![0].message).toContain("breadcrumb test error");
  });
});
