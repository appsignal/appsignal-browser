import { describe, it, expect, vi, beforeEach } from "vitest";
import { initErrors, getLastErrorTimestamp } from "./errors.js";
import * as transport from "./transport.js";
import * as breadcrumbs from "./breadcrumbs.js";
import * as session from "./session.js";
import * as replay from "./replay.js";
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

vi.mock("./replay.js", () => ({
  onError: vi.fn(),
}));

const sendErrorMock = transport.sendError as ReturnType<typeof vi.fn>;
const replayOnError = replay.onError as ReturnType<typeof vi.fn>;
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

// Track calls since last reset — initErrors adds listeners cumulatively
function callsSince(mock: ReturnType<typeof vi.fn>, since: number) {
  return mock.mock.calls.length - since;
}

describe("errors", () => {
  let sendBefore: number;
  let replayBefore: number;
  let breadcrumbBefore: number;

  beforeEach(() => {
    sendBefore = sendErrorMock.mock.calls.length;
    replayBefore = replayOnError.mock.calls.length;
    breadcrumbBefore = addBreadcrumbMock.mock.calls.length;
  });

  it("sends error events via transport", () => {
    initErrors({ enabled: true, sample_rate: 1.0 }, "v1.0");
    fireError("Test error");

    expect(callsSince(sendErrorMock, sendBefore)).toBeGreaterThanOrEqual(1);
    const lastCall = sendErrorMock.mock.calls[sendErrorMock.mock.calls.length - 1];
    const payload = lastCall[0] as BrowserError;
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

    expect(callsSince(sendErrorMock, sendBefore)).toBeGreaterThanOrEqual(1);
    const lastCall = sendErrorMock.mock.calls[sendErrorMock.mock.calls.length - 1];
    const payload = lastCall[0] as BrowserError;
    expect(payload.error_class).toBe("TypeError");
  });

  it("does not send when disabled", () => {
    initErrors({ enabled: false, sample_rate: 1.0 });
    fireError("Test error");

    expect(callsSince(sendErrorMock, sendBefore)).toBe(0);
  });

  describe("ignoreErrors", () => {
    it("filters by string substring match", () => {
      initErrors({ enabled: true, sample_rate: 1.0 }, undefined, undefined, [
        "ResizeObserver loop",
      ]);
      fireError("ResizeObserver loop limit exceeded");

      expect(callsSince(sendErrorMock, sendBefore)).toBe(0);
    });

    it("filters by regex match", () => {
      initErrors({ enabled: true, sample_rate: 1.0 }, undefined, undefined, [
        /Script error\.?/,
      ]);
      fireError("Script error.");

      expect(callsSince(sendErrorMock, sendBefore)).toBe(0);
    });

    it("sends non-matching errors", () => {
      initErrors({ enabled: true, sample_rate: 1.0 }, undefined, undefined, [
        "ResizeObserver",
      ]);
      fireError("TypeError: Cannot read property 'foo'");

      expect(callsSince(sendErrorMock, sendBefore)).toBeGreaterThanOrEqual(1);
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

      const lastCall = sendErrorMock.mock.calls[sendErrorMock.mock.calls.length - 1];
      const payload = lastCall[0] as BrowserError;
      expect(payload.message).toBe("redacted");
    });

    it("can drop the event by returning null", () => {
      const hook = vi.fn(() => null);
      initErrors({ enabled: true, sample_rate: 1.0 }, undefined, hook);
      const before = sendErrorMock.mock.calls.length;
      fireError("drop me");

      expect(hook).toHaveBeenCalled();
      expect(callsSince(sendErrorMock, before)).toBe(0);
    });
  });

  describe("deduplication", () => {
    it("suppresses repeated identical errors after 5 occurrences", () => {
      initErrors({ enabled: true, sample_rate: 1.0 });
      const before = sendErrorMock.mock.calls.length;

      // Use a unique stack to avoid interference from other tests
      const uniqueStack = `Error\n    at dedup_test_${Date.now()} (test.js:1:1)`;
      for (let i = 0; i < 10; i++) {
        fireError("dedup test error", uniqueStack);
      }

      // First 5 should be sent, 6-10 suppressed
      const sent = callsSince(sendErrorMock, before);
      expect(sent).toBe(5);
    });
  });

  describe("sample rate", () => {
    it("drops errors when sample_rate is 0", () => {
      initErrors({ enabled: true, sample_rate: 0 });
      fireError("should be dropped");

      expect(callsSince(sendErrorMock, sendBefore)).toBe(0);
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

  it("notifies replay on error", () => {
    initErrors({ enabled: true, sample_rate: 1.0 });
    fireError("replay notify test");

    expect(callsSince(replayOnError, replayBefore)).toBeGreaterThanOrEqual(1);
  });

  it("adds error breadcrumb", () => {
    initErrors({ enabled: true, sample_rate: 1.0 });
    fireError("breadcrumb test error");

    const recentCalls = addBreadcrumbMock.mock.calls.slice(breadcrumbBefore);
    const errorBreadcrumb = recentCalls.find(
      (call: unknown[]) => call[0]?.category === "error",
    );
    expect(errorBreadcrumb).toBeTruthy();
    expect(errorBreadcrumb[0].message).toContain("breadcrumb test error");
  });
});
