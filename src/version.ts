// Replaced by esbuild `define` (build.mjs) and by vitest `define`
// (vitest.config.ts) with the version in package.json, so a release bump is
// the only place the version is written.
declare const __APPSIGNAL_BROWSER_VERSION__: string;

export const SDK_VERSION: string = __APPSIGNAL_BROWSER_VERSION__;
