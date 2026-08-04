// @vitest-environment node
//
// Importing the SDK must not touch the DOM: patching history before init() makes
// `active: false` a lie. No DOM globals here, so any such access throws.
import { describe, expect, it } from "vitest";

describe("importing the SDK", () => {
  it("does not touch the DOM", async () => {
    expect(typeof globalThis.window).toBe("undefined");
    expect(typeof globalThis.history).toBe("undefined");

    await expect(import("./index.js")).resolves.toBeDefined();
  });

  it("exposes the public API", async () => {
    const sdk = await import("./index.js");

    expect(typeof sdk.init).toBe("function");
    expect(typeof sdk.captureError).toBe("function");
    expect(typeof sdk.addBreadcrumb).toBe("function");
  });
});
