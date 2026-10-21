import { stripTrailingSlash } from "./utils.js";

// The route the host declared, such as "/users/:id" or a screen name. Errors
// group by it, and vitals attribute to it. It is its own module so the errors
// pipeline does not depend on the vitals collector.
let current = "";

export function getRouteTemplate(): string {
  return current;
}

export function setRouteTemplate(template: string | null): void {
  current = stripTrailingSlash((template ?? "").trim());
}

export function clearRouteTemplate(): void {
  current = "";
}
