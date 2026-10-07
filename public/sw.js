// NOTE: THIS FILE IS NOT EXACTLY WHAT SHIPS.
//
// During `npm run build`, a small step in vite.config.js fills in BUILD_ID
// and BUILD_ASSETS below (between the "build:" and "end" markers) with the list
// of that build's hashed files, e.g. assets/index-D-uGn5bA.css. Look at
// dist/sw.js to see the real values.
//
// Because the list changes whenever the app's code changes, each deploy
// produces a different sw.js. The browser then installs the new service
// worker, which caches the new build's files (install) and only afterwards
// deletes the previous build's cache (activate). That keeps the cache to one
// build's worth of files, so it does not grow with every deploy.
//
// As written here (and in `npm run dev`, which has no build step), the list
// is empty and BUILD_ID is "dev": the service worker caches nothing extra.

const BUILD_ID = /* build:id */ "dev" /* end */;
const BUILD_ASSETS = /* build:assets */ [] /* end */;

const CACHE_PREFIX = "ridge-trail-passport-shell-";
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_ID}`;
const CORE_ASSETS = [
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

  await Promise.all(
    CORE_ASSETS.map(async (path) => {
      try {
        const response = await fetch(path, { cache: "no-store" });
        if (response.ok) await cache.put(path, response);
      } catch {
        // A nonessential shell asset should not block service-worker install.
      }
    })
  );
}

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

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Deliberately leave ArcGIS, the basemap (OpenFreeMap style and tiles),
  // attachment images, and every other third-party request to the
  // browser/network. This service worker caches only the Passport's own
  // same-origin application files.
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
