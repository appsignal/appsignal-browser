import { describe, expect, it } from "vitest";
import { matchesUrl } from "./utils.js";

// The host and the path are matched separately. Gluing them let a path
// segment stand in for a host.
describe("matchesUrl", () => {
  const cases: [string, string, boolean][] = [
    // A host pattern matches that host, whatever the URL carries around it.
    ["api.example.com/**", "https://api.example.com/users/42", true],
    ["api.example.com/**", "https://API.EXAMPLE.COM/users/42", true],
    ["api.example.com/**", "https://api.example.com./users/42", true],
    ["api.example.com/**", "https://api.example.com:8443/users/42", true],
    // A path segment is not a host.
    ["api.example.com/**", "https://evil.com/api.example.com/x", false],
    ["**.example.com/**", "https://evil.com/cdn/logo.example.com/x", false],
    ["**.example.com/**", "https://api.example.com/x", true],
    // A pattern that names a port means that port.
    ["localhost:5005/**", "http://localhost:5005/api/orders", true],
    ["localhost:5005/**", "http://localhost:3000/api/orders", false],
    ["localhost/**", "http://localhost:5005/api/orders", true],
    // No path part means the whole host.
    ["api.example.com", "https://api.example.com/anything/at/all", true],
    // One `*` stays inside a path segment; `**` crosses them.
    ["api.example.com/v1/*", "https://api.example.com/v1/users", true],
    ["api.example.com/v1/*", "https://api.example.com/v1/users/42", false],
    ["api.example.com/v1/**", "https://api.example.com/v1/users/42", true],
    // `**` before a path segment still means "anywhere in the path", so a
    // blocklist entry keeps covering what it covered before.
    ["**/auth/**", "https://app.example.com/api/auth/login", true],
    ["**/auth/**", "https://app.example.com/auth/login", true],
    ["**/auth/**", "https://app.example.com/api/orders", false],
    ["**/*", "https://app.example.com/api/echo", true],
    // A host wildcard still means any host, which is what it says.
    ["*/auth/token", "https://any.host.example/auth/token", true],
  ];

  for (const [pattern, url, expected] of cases) {
    it(`${expected ? "matches" : "does not match"} ${pattern} against ${url}`, () => {
      expect(matchesUrl(pattern, new URL(url))).toBe(expected);
    });
  }
});
