const CACHE_PREFIX = "ridge-trail-passport-shell-";
const CACHE_NAME = `${CACHE_PREFIX}v2`;
const CORE_ASSETS = [
  "./",
  "./manifest.webmanifest",
  "./ridge-trail-logo.png",
  "./ridge-trail-app-icon-180.png",
  "./ridge-trail-app-icon-192.png",
  "./ridge-trail-app-icon-512.png"
];

async function cacheAppShell() {
  const cache = await caches.open(CACHE_NAME);

  const pageResponse = await fetch("./", { cache: "no-store" });
  if (!pageResponse.ok) throw new Error("Could not cache Passport shell");

  await cache.put("./", pageResponse.clone());

  const html = await pageResponse.text();
  const urls = new Set(CORE_ASSETS.slice(1));

  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    try {
      const url = new URL(match[1], self.registration.scope);
      if (url.origin === self.location.origin) {
        urls.add(url.href);
      }
    } catch {
      // Ignore malformed or non-URL attributes.
    }
  }

  await Promise.all(
    [...urls].map(async (url) => {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (response.ok) await cache.put(url, response);
      } catch {
        // A nonessential shell asset should not block service-worker install.
      }
    })
  );

  // Some files are loaded by the app's JavaScript rather than listed in the
  // HTML — notably the map's background worker, without which the trail
  // cannot be drawn. Find them inside the cached scripts and cache them too,
  // so the map still works offline after the first visit.
  const scriptUrls = [...urls]
    .map((url) => new URL(url, self.registration.scope).href)
    .filter((url) => new URL(url).pathname.endsWith(".js"));

  await Promise.all(
    scriptUrls.map(async (scriptUrl) => {
      const script = await cache.match(scriptUrl);
      if (!script) return;

      const text = await script.text();
      const pattern =
        /new URL\(\s*[`'"]([^`'"]+)[`'"]\s*,\s*import\.meta\.url\s*\)/g;

      for (const match of text.matchAll(pattern)) {
        try {
          const url = new URL(match[1], scriptUrl);
          if (url.origin !== self.location.origin) continue;

          const response = await fetch(url.href, { cache: "no-store" });
          if (response.ok) await cache.put(url.href, response);
        } catch {
          // A nonessential asset should not block service-worker install.
        }
      }
    })
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheAppShell().then(() => self.skipWaiting()));
});

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

async function networkFirst(request, navigationFallback = false) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
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

  event.respondWith(networkFirst(request));
});
