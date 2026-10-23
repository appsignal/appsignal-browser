import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { SDK_VERSION } from "./version.js";

describe("SDK_VERSION", () => {
  it("is the version in package.json", () => {
    const { version } = JSON.parse(readFileSync("package.json", "utf8"));
    expect(SDK_VERSION).toBe(version);
  });
});
