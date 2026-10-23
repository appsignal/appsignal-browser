// Replaced by esbuild `define` (build.mjs) with the version in package.json, so
// a release bump is the only place the version is written. Unbundled code,
// such as the unit tests, has no `define` and reports "development".
declare const __APPSIGNAL_BROWSER_VERSION__: string | undefined;

export const SDK_VERSION: string =
  typeof __APPSIGNAL_BROWSER_VERSION__ === "string" ? __APPSIGNAL_BROWSER_VERSION__ : "development";
