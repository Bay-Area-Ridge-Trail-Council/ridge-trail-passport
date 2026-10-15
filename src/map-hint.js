import { CONFIG } from "./config.js";

// Remembering that the "Tap a main Ridge Trail line…" hint has done its job.
// Once a visitor has selected a section, they know how, so the hint is not
// shown again.
//
// This is screen state, not progress: it has its own key, separate from
// saved progress, and is never part of a progress backup. If storage is
// missing or blocked, the hint is simply shown (it fails open). It must
// never stop the app.

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export function isMapHintDismissed(storage = defaultStorage()) {
  try {
    return storage?.getItem(CONFIG.mapHint.storageKey) === "1";
  } catch {
    return false;
  }
}

// Returns true if the flag was saved, false if storage is unavailable.
export function saveMapHintDismissed(storage = defaultStorage()) {
  try {
    storage.setItem(CONFIG.mapHint.storageKey, "1");
    return true;
  } catch {
    return false;
  }
}
