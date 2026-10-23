// Set by esbuild `define` in build.mjs.
declare const __APPSIGNAL_BROWSER_VERSION__: string | undefined;

export const SDK_VERSION: string =
  typeof __APPSIGNAL_BROWSER_VERSION__ === "string" ? __APPSIGNAL_BROWSER_VERSION__ : "development";
