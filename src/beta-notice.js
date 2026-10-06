import { CONFIG } from "./config.js";

// Saving and reading the "I've seen the beta notice" flag. Storage can be
// missing or blocked (private browsing, strict settings); in that case the
// notice is simply shown again next time. It must never stop the app.

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export function isBetaNoticeAcknowledged(storage = defaultStorage()) {
  try {
    const saved = Number(storage?.getItem(CONFIG.betaNotice.storageKey));
    return saved >= CONFIG.betaNotice.version;
  } catch {
    return false;
  }
}

// Returns true if the flag was saved, false if storage is unavailable.
export function acknowledgeBetaNotice(storage = defaultStorage()) {
  try {
    storage.setItem(
      CONFIG.betaNotice.storageKey,
      String(CONFIG.betaNotice.version)
    );
    return true;
  } catch {
    return false;
  }
}
