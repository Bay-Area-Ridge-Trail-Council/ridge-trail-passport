import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import { CONFIG } from "./src/config.js";
import { trailQueryUrl } from "./src/data.js";

// Vite's hashed output: assets/<name>-<8 character hash>.js or .css.
// Must match HASHED_ASSET in public/sw.js.
const HASHED_ASSET = /^assets\/[^/]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/;

// Writes this build's hashed file list and the basemap style address (from
// src/config.js) into dist/sw.js (see the note at the top of public/sw.js).
// public/sw.js itself is never changed. Only runs for `npm run build`;
// `npm run dev` serves public/sw.js with an empty list and no basemap address.
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
        .replace(/\/\* build:assets \*\/.*?\/\* end \*\//, JSON.stringify(hashedFiles.map((f) => `./${f}`)))
        .replace(/\/\* build:basemap-style \*\/.*?\/\* end \*\//, JSON.stringify(CONFIG.basemap.styleUrl));

      // Fail the build rather than ship a service worker without its list.
      if (/\/\* build:(id|assets|basemap-style) \*\//.test(filled) || hashedFiles.length === 0) {
        throw new Error("Could not write the build's file list into dist/sw.js");
      }

      writeFileSync(file, filled);
    }
  };
}

// Fills in the web addresses that index.html uses before the app's own code
// has downloaded: the trail data request and the two preconnect links. They
// come from src/config.js, so each address is still written down only once
// and changing the basemap stays a one-line edit there.
export function fillStartupAddresses(html) {
  const filled = html
    .replace(/\/\* trail-query-url \*\/.*?\/\* end \*\//, JSON.stringify(trailQueryUrl()))
    .replaceAll("%TRAIL_DATA_ORIGIN%", new URL(CONFIG.featureService).origin)
    .replaceAll("%BASEMAP_ORIGIN%", new URL(CONFIG.basemap.styleUrl).origin);

  // Fail rather than ship a page that asks for a placeholder.
  if (/trail-query-url|%TRAIL_DATA_ORIGIN%|%BASEMAP_ORIGIN%/.test(filled)) {
    throw new Error("Could not fill in the startup addresses in index.html");
  }

  return filled;
}

function startupAddresses() {
  return {
    name: "startup-addresses",
    transformIndexHtml: { order: "pre", handler: fillStartupAddresses }
  };
}

export default defineConfig({
  base: "./",
  plugins: [startupAddresses(), serviceWorkerFileList()],
  server: {
    host: true
  },
  preview: {
    host: true
  }
});
