import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";

const shared = {
  bundle: true,
  sourcemap: true,
  target: "es2020",
};

// ESM with code splitting — replay chunk loaded on demand
await build({
  ...shared,
  entryPoints: ["src/index.ts"],
  format: "esm",
  splitting: true,
  outdir: "dist/esm",
  chunkNames: "chunks/[name]-[hash]",
});

// UMD — single file, everything included (replay bundled inline)
await build({
  ...shared,
  entryPoints: ["src/index.ts"],
  format: "iife",
  globalName: "AppsignalBrowser",
  outfile: "dist/browser.umd.js",
  footer: {
    js: "if(typeof module!=='undefined')module.exports=AppsignalBrowser;",
  },
});

// React adapter — separate ESM bundle, react/react-dom external (peer dep)
await build({
  ...shared,
  entryPoints: ["src/react/index.tsx"],
  format: "esm",
  outfile: "dist/react/index.js",
  external: ["react", "react-dom", "react/jsx-runtime"],
});

// Print sizes
function showSize(path, label) {
  const buf = readFileSync(path);
  const gz = gzipSync(buf);
  console.log(`  ${label}: ${(buf.length / 1024).toFixed(0)} KB raw, ${(gz.length / 1024).toFixed(0)} KB gzipped`);
}

console.log("Build complete:");
showSize("dist/esm/index.js", "ESM (core)");
showSize("dist/browser.umd.js", "UMD (all-in-one)");
showSize("dist/react/index.js", "React adapter");
