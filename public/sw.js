// NOTE: THIS FILE IS NOT EXACTLY WHAT SHIPS.
//
// During `npm run build`, a small step in vite.config.js fills in BUILD_ID
// and BUILD_ASSETS below (between the "build:" and "end" markers) with the list
// of that build's hashed files, e.g. assets/index-D-uGn5bA.css. It also fills
// in BASEMAP_STYLE_URL from src/config.js. Look at dist/sw.js to see the real
// values.
//
// Because the list changes whenever the app's code changes, each deploy
// produces a different sw.js. The browser then installs the new service
// worker, which caches the new build's files (install) and only afterwards
// deletes the previous build's cache (activate). That keeps the cache to one
// build's worth of files, so it does not grow with every deploy.
//
// As written here (and in `npm run dev`, which has no build step), the list
// is empty, BUILD_ID is "dev" and BASEMAP_STYLE_URL is "": the service worker
// caches nothing extra and leaves the basemap alone.

const BUILD_ID = /* build:id */ "dev" /* end */;
const BUILD_ASSETS = /* build:assets */ [] /* end */;
const BASEMAP_STYLE_URL = /* build:basemap-style */ "" /* end */;

const CACHE_PREFIX = "ridge-trail-passport-shell-";
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_ID}`;
// Not needed to open the Passport offline, so not cached during install,
// where they would compete with the trail data on a slow connection (about
// 140 kB). The page asks for them once the trail data has loaded and the
// browser is idle (see requestOfflineExtras in src/offline.js).
const EXTRA_ASSETS = [
  "./manifest.webmanifest",
  "./ridge-trail-logo.png",
  "./ridge-trail-app-icon-180.png",
  "./ridge-trail-app-icon-192.png",
  "./ridge-trail-app-icon-512.png"
];

// Vite's hashed output: assets/<name>-<8 character hash>.js or .css. A
// changed file always gets a new name, so these never need re-checking.
// Must match the pattern in vite.config.js.
const HASHED_ASSET = /\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/;

const buildAssetUrls = new Set(
  BUILD_ASSETS.map((path) => new URL(path, self.registration.scope).href)
);

async function cacheAppShell() {
  const cache = await caches.open(CACHE_NAME);

  // Every one of this build's hashed files must be cached, or the install
  // fails and the previous service worker and its cache stay in charge.
  await cache.addAll([...buildAssetUrls]);

  const pageResponse = await fetch("./", { cache: "no-store" });
  if (!pageResponse.ok) throw new Error("Could not cache Passport shell");

  // If a newer deploy went live mid-install, let its service worker take over.
  if (!(await pageMatchesBuild(pageResponse.clone()))) {
    throw new Error("Passport page is from a different build");
  }
  await cache.put("./", pageResponse);
}

// Adds whichever EXTRA_ASSETS this build's cache doesn't have yet, so after
// the first visit (and the first after each deploy) nothing is downloaded.
async function cacheExtras() {
  const cache = await caches.open(CACHE_NAME);

  await Promise.all(
    EXTRA_ASSETS.map(async (path) => {
      if (await cache.match(path)) return;

      try {
        // "no-cache" checks with the server but reuses the browser's copy
        // (such as the logo the page just showed) if it hasn't changed.
        const response = await fetch(path, { cache: "no-cache" });
        if (response.ok) await cache.put(path, response);
      } catch {
        // Nonessential; tried again on the next visit.
      }
    })
  );
}

self.addEventListener("message", (event) => {
  if (event.data === "cache-extras") event.waitUntil(cacheExtras());
});

self.addEventListener("install", (event) => {
  event.waitUntil(
    cacheAppShell()
      .then(() => self.skipWaiting())
      .catch(async (error) => {
        // Don't leave a half-filled cache behind; try again next visit.
        await caches.delete(CACHE_NAME);
        throw error;
      })
  );
});

// Runs only after install has fully succeeded: remove every older cache.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME
            )
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// True if every hashed file the page links to belongs to this build. A page
// from a newer deploy is left for that deploy's service worker to cache, so
// this cache never holds a page whose files it doesn't have.
async function pageMatchesBuild(response) {
  const html = await response.text();

  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    try {
      const url = new URL(match[1], self.registration.scope);
      if (HASHED_ASSET.test(url.pathname) && !buildAssetUrls.has(url.href)) {
        return false;
      }
    } catch {
      // Ignore malformed or non-URL attributes.
    }
  }

  return true;
}

async function networkFirst(request, navigationFallback = false) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const response = await fetch(request);

    if (response.ok) {
      const isCurrentBuild =
        !navigationFallback || (await pageMatchesBuild(response.clone()));
      if (isCurrentBuild) await cache.put(request, response.clone());
    }

    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;

    if (navigationFallback) {
      const shell = await cache.match("./");
      if (shell) return shell;
    }

    throw error;
  }
}

// Hashed files: served from the cache with no network request. Only this
// build's files are added to the cache, so it stays one build's worth.
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok && buildAssetUrls.has(request.url)) {
    await cache.put(request, response.clone());
  }
  return response;
}

// --- Basemap style files ----------------------------------------------------
//
// The basemap's style document, its sprite (map icons: a .json index and a
// .png image) and its glyphs (font ranges for map labels) rarely change, so
// they are served from the cache straight away and then refreshed in the
// background for next time. A style change therefore shows up on the visit
// after it is published. That is accepted.
//
// Map tiles are NOT cached; they always go straight to the network. Only
// addresses named by the style document itself are cached: the style's own
// address, its "sprite" address and its "glyphs" address pattern. Tiles come
// from a different address (listed in the tile source, not in the style),
// so they never match.
//
// Careful: glyph files and vector tiles both end in .pbf. They are told
// apart by address, never by file extension:
//   glyphs (cached):     https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/0-255.pbf
//   vector tile (never): https://tiles.openfreemap.org/planet/20250101_001001_pt/9/81/197.pbf
//
// These live in their own cache, separate from the app's files, so a new
// deploy of the app does not delete them.
const BASEMAP_CACHE = "ridge-trail-passport-basemap";

// Which sprite and glyph addresses the cached style uses. Read from the
// cached style when the service worker starts, and updated whenever a new
// style arrives. Until then (the very first visit), only the style itself
// is cached; its sprite and glyphs are cached from the next visit on.
let styleFiles = null;

// Given a style document, returns a test for whether an address is one of
// the files it names (the style itself, its sprite or its glyphs).
function styleFileTest(style) {
  const sprites = [];
  const spriteSetting = style?.sprite;
  for (const sprite of Array.isArray(spriteSetting) ? spriteSetting : [spriteSetting]) {
    const address = typeof sprite === "string" ? sprite : sprite?.url;
    if (typeof address === "string") sprites.push(address);
  }

  // The glyphs setting is an address with {fontstack} and {range} in it,
  // e.g. https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf
  let glyphs = null;
  if (typeof style?.glyphs === "string") {
    const escaped = style.glyphs.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
    glyphs = new RegExp(
      "^" +
        escaped
          .replace("{fontstack}", "[^/?#]+")
          .replace("{range}", "\\d+-\\d+") +
        "$"
    );
  }

  return (address) => {
    if (address === BASEMAP_STYLE_URL) return true;
    // MapLibre asks for <sprite>.json and <sprite>.png, or @2x versions of
    // both on high-resolution screens.
    for (const sprite of sprites) {
      if (/^(?:@2x)?\.(?:json|png)$/.test(address.slice(sprite.length)) &&
        address.startsWith(sprite)) {
        return true;
      }
    }
    return Boolean(glyphs?.test(address));
  };
}

async function loadStyleFiles() {
  try {
    const cache = await caches.open(BASEMAP_CACHE);
    const cached = await cache.match(BASEMAP_STYLE_URL);
    if (cached && !styleFiles) styleFiles = styleFileTest(await cached.json());
  } catch {
    // No usable cached style yet; it will be cached on this visit.
  }
}

if (BASEMAP_STYLE_URL) loadStyleFiles();

function isBasemapStyleFile(address) {
  if (!BASEMAP_STYLE_URL) return false;
  if (address === BASEMAP_STYLE_URL) return true;
  return Boolean(styleFiles?.(address));
}

// Stores a fresh copy. When it is the style document, also removes cached
// sprite and glyph files the new style no longer uses (for example after
// the provider moves to a new sprite version), so old files don't pile up.
async function saveBasemapFile(cache, address, response) {
  if (address !== BASEMAP_STYLE_URL) {
    await cache.put(address, response);
    return;
  }

  const style = await response.clone().json();
  await cache.put(address, response);
  styleFiles = styleFileTest(style);

  for (const request of await cache.keys()) {
    if (!styleFiles(request.url)) await cache.delete(request);
  }
}

// Downloads a fresh copy and saves it over the cached one. "no-cache" lets
// the browser ask the server whether its own copy is still current instead
// of downloading it again. If the network or server fails, nothing changes.
async function refreshBasemapFile(address) {
  try {
    const response = await fetch(address, { cache: "no-cache" });
    if (!response.ok) return;

    const cache = await caches.open(BASEMAP_CACHE);
    await saveBasemapFile(cache, address, response);
  } catch {
    // Offline or the server is down: keep serving the cached copy.
  }
}

// Cached copy first; fetch a fresh one in the background for next time. If
// that fails (offline), the cached copy simply stays.
async function cacheFirstThenRefresh(event) {
  const address = event.request.url;
  const cache = await caches.open(BASEMAP_CACHE);
  // MapLibre sends an Accept header; ignore it when looking up the copy.
  const cached = await cache.match(address, { ignoreVary: true });

  if (cached) {
    event.waitUntil(refreshBasemapFile(address));
    return cached;
  }

  // Nothing cached yet: answer from the network and keep a copy. If the
  // network fails, the map gets the usual error, which it already handles.
  const response = await fetch(event.request);
  if (response.ok) {
    event.waitUntil(saveBasemapFile(cache, address, response.clone()).catch(() => {}));
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // The basemap's style, sprite and glyphs (see "Basemap style files").
  if (isBasemapStyleFile(request.url)) {
    event.respondWith(cacheFirstThenRefresh(event));
    return;
  }

  // Deliberately leave ArcGIS, map tiles, attachment images, and every other
  // third-party request to the browser/network. ArcGIS data is already kept
  // in IndexedDB by the app; a second copy here would drift out of step.
  if (url.origin !== self.location.origin) return;

  if (url.pathname.endsWith("/sw.js")) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, true));
    return;
  }

  if (HASHED_ASSET.test(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  event.respondWith(networkFirst(request));
});
