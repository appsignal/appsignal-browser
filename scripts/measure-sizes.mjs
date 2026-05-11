import { readFileSync, readdirSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

function gz(path) {
  return gzipSync(readFileSync(path)).length;
}

function file(path) {
  return { raw: statSync(path).size, gz: gz(path) };
}

function dir(path, ext = ".js") {
  let raw = 0;
  let gzTotal = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const p = join(path, entry.name);
    if (entry.isDirectory()) {
      const sub = dir(p, ext);
      raw += sub.raw;
      gzTotal += sub.gz;
    } else if (entry.name.endsWith(ext)) {
      raw += statSync(p).size;
      gzTotal += gz(p);
    }
  }
  return { raw, gz: gzTotal };
}

const sizes = {
  "esm-entry": { label: "ESM (entry)", ...file("dist/esm/index.js") },
  "esm-total": { label: "ESM (entry + chunks)", ...dir("dist/esm") },
  umd: { label: "UMD (all-in-one)", ...file("dist/browser.umd.js") },
  react: { label: "React adapter", ...file("dist/react/index.js") },
};

process.stdout.write(JSON.stringify(sizes, null, 2));
