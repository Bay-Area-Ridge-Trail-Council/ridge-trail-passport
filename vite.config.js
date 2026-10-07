import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

// Vite's hashed output: assets/<name>-<8 character hash>.js or .css.
// Must match HASHED_ASSET in public/sw.js.
const HASHED_ASSET = /^assets\/[^/]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/;

// Writes this build's hashed file list into dist/sw.js (see the note at the
// top of public/sw.js). public/sw.js itself is never changed. Only runs for
// `npm run build`; `npm run dev` serves public/sw.js with an empty list.
function serviceWorkerFileList() {
  let hashedFiles = [];
  let outDir;

  return {
    name: "service-worker-file-list",
    apply: "build",

    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },

    generateBundle(_options, bundle) {
      hashedFiles = Object.keys(bundle).filter((file) => HASHED_ASSET.test(file)).sort();
    },

    // Runs after Vite has copied public/sw.js into dist/.
    closeBundle() {
      const file = resolve(outDir, "sw.js");
      const source = readFileSync(file, "utf8");
      const buildId = createHash("sha256").update(hashedFiles.join("\n")).digest("hex").slice(0, 12);

      const filled = source
        .replace(/\/\* build:id \*\/.*?\/\* end \*\//, JSON.stringify(buildId))
        .replace(/\/\* build:assets \*\/.*?\/\* end \*\//, JSON.stringify(hashedFiles.map((f) => `./${f}`)));

      // Fail the build rather than ship a service worker without its list.
      if (/\/\* build:(id|assets) \*\//.test(filled) || hashedFiles.length === 0) {
        throw new Error("Could not write the build's file list into dist/sw.js");
      }

      writeFileSync(file, filled);
    }
  };
}

export default defineConfig({
  base: "./",
  plugins: [serviceWorkerFileList()],
  server: {
    host: true
  },
  preview: {
    host: true
  }
});
