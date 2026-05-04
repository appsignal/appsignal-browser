import { describe, it, expect, vi, beforeEach } from "vitest";
import { getConsent, setConsent, onConsentGranted, onConsentDenied } from "./consent.js";

describe("consent", () => {
  beforeEach(() => {
    // Reset to default
    setConsent("granted");
  });

  it("defaults to granted", () => {
    expect(getConsent()).toBe("granted");
  });

  it("can be set to pending", () => {
    setConsent("pending");
    expect(getConsent()).toBe("pending");
  });

  it("can be set to not-granted", () => {
    setConsent("not-granted");
    expect(getConsent()).toBe("not-granted");
  });

  it("calls onConsentGranted callbacks when transitioning to granted", () => {
    const cb = vi.fn();
    onConsentGranted(cb);

    setConsent("pending");
    setConsent("granted");

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("calls onConsentDenied callbacks when transitioning to not-granted", () => {
    const cb = vi.fn();
    onConsentDenied(cb);

    setConsent("not-granted");

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("does not call granted callback when already granted", () => {
    const cb = vi.fn();
    onConsentGranted(cb);

    setConsent("granted"); // already granted

    expect(cb).not.toHaveBeenCalled();
  });

  it("does not call denied callback when already not-granted", () => {
    const cb = vi.fn();
    onConsentDenied(cb);

    setConsent("not-granted");
    cb.mockClear();

    setConsent("not-granted"); // already not-granted

    expect(cb).not.toHaveBeenCalled();
  });

  it("supports pending → granted flow", () => {
    const granted = vi.fn();
    onConsentGranted(granted);

    setConsent("pending");
    expect(granted).not.toHaveBeenCalled();

    setConsent("granted");
    expect(granted).toHaveBeenCalledTimes(1);
  });

  it("supports pending → not-granted flow", () => {
    const denied = vi.fn();
    onConsentDenied(denied);

    setConsent("pending");
    expect(denied).not.toHaveBeenCalled();

    setConsent("not-granted");
    expect(denied).toHaveBeenCalledTimes(1);
  });
});
