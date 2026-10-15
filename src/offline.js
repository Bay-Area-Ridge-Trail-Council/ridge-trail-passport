const DB_NAME = "ridge-trail-passport";
const DB_VERSION = 1;
const STORE_NAME = "trail-data";
const TRAIL_CACHE_KEY = "latest-features";

function openDatabase() {
  if (!("indexedDB" in window)) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readCachedTrailFeatures() {
  let database;

  try {
    database = await openDatabase();
    if (!database) return null;

    const cached = await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(TRAIL_CACHE_KEY);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    return Array.isArray(cached?.features) ? cached.features : null;
  } catch (error) {
    console.warn("Could not read cached Ridge Trail data", error);
    return null;
  } finally {
    database?.close();
  }
}

export async function writeCachedTrailFeatures(features) {
  if (!Array.isArray(features)) return;

  let database;

  try {
    database = await openDatabase();
    if (!database) return;

    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(
        {
          features,
          savedAt: Date.now()
        },
        TRAIL_CACHE_KEY
      );

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } catch (error) {
    console.warn("Could not save Ridge Trail data for offline use", error);
  } finally {
    database?.close();
  }
}

export function sameTrailSnapshot(first, second) {
  if (!Array.isArray(first) || !Array.isArray(second)) return false;
  if (first.length !== second.length) return false;

  try {
    return JSON.stringify(first) === JSON.stringify(second);
  } catch {
    return false;
  }
}

export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.warn("Could not register offline support", error);
    });
  });
}

// Asks the service worker to save the logo and app icons for offline use
// (see EXTRA_ASSETS in public/sw.js). Called once the trail data has loaded,
// and waits until the page has finished loading and the browser is idle, so
// on a slow connection these never compete with the trail data.
export function requestOfflineExtras() {
  if (!("serviceWorker" in navigator)) return;

  const ask = () =>
    navigator.serviceWorker.ready
      .then((registration) => registration.active?.postMessage("cache-extras"))
      .catch(() => {});

  const whenIdle = () => {
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(ask, { timeout: 5000 });
    } else {
      window.setTimeout(ask, 1000);
    }
  };

  if (document.readyState === "complete") {
    whenIdle();
  } else {
    window.addEventListener("load", whenIdle, { once: true });
  }
}
