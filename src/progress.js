import { CONFIG } from "./config.js";
import { isCompletionEligible, milesFor } from "./trails.js";

const BACKUP_APP_NAME = "Ridge Trail Passport";
const BACKUP_VERSION = 1;
const STORAGE_KEY_PREFIX = "segment-";

// Thrown by toggle() when the browser refuses to save. The change has
// already been undone, so progress is exactly as it was before.
export class ProgressNotSavedError extends Error {
  constructor() {
    super("Could not save Ridge Trail completion data.");
    this.name = "ProgressNotSavedError";
  }
}

function segmentIdFor(properties = {}) {
  return String(properties.Segment_ID || "").trim();
}

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function loadProgress(storage) {
  if (!storage) return {};

  try {
    const parsed = JSON.parse(storage.getItem(CONFIG.storageKey) || "{}");

    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function completedAtFor(value, fallback = new Date().toISOString()) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return Number.isNaN(Date.parse(value)) ? fallback : value;
}

export function createProgressStore({ storage = defaultStorage() } = {}) {
  let progress = loadProgress(storage);
  let invalidSegmentIds = new Set();

  function keyFor(properties) {
    const segmentId = segmentIdFor(properties);

    if (!segmentId || invalidSegmentIds.has(segmentId)) {
      return null;
    }

    return `${STORAGE_KEY_PREFIX}${segmentId}`;
  }

  function persist() {
    if (!storage) return false;

    try {
      storage.setItem(CONFIG.storageKey, JSON.stringify(progress));
      return true;
    } catch (error) {
      console.warn("Could not persist Ridge Trail completion data", error);
      return false;
    }
  }

  function isDone(properties) {
    if (!isCompletionEligible(properties)) return false;

    const key = keyFor(properties);
    return key ? Boolean(progress[key]) : false;
  }

  return {
    isDone,

    setInvalidSegmentIds(segmentIds = []) {
      invalidSegmentIds = new Set(
        segmentIds
          .map((value) => String(value ?? "").trim())
          .filter(Boolean)
      );
    },

    toggle(properties) {
      if (!isCompletionEligible(properties)) return null;

      const key = keyFor(properties);
      if (!key) return null;

      const previous = progress[key];

      if (previous) {
        delete progress[key];
      } else {
        progress[key] = {
          completedAt: new Date().toISOString()
        };
      }

      // If the save fails, undo the change so the app never shows a
      // completion (or a removal) that isn't actually stored.
      if (!persist()) {
        if (previous) progress[key] = previous;
        else delete progress[key];

        throw new ProgressNotSavedError();
      }

      return Boolean(progress[key]);
    },

    exportData() {
      const completed = Object.entries(progress)
        .filter(([key, value]) =>
          key.startsWith(STORAGE_KEY_PREFIX) && value && typeof value === "object"
        )
        .map(([key, value]) => ({
          segmentId: key.slice(STORAGE_KEY_PREFIX.length),
          completedAt: completedAtFor(value.completedAt)
        }))
        .filter((entry) => entry.segmentId)
        .sort((a, b) => a.segmentId.localeCompare(b.segmentId));

      return {
        app: BACKUP_APP_NAME,
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        completed
      };
    },

    importData(data) {
      if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        data.app !== BACKUP_APP_NAME ||
        data.version !== BACKUP_VERSION ||
        !Array.isArray(data.completed)
      ) {
        throw new Error("This is not a valid Ridge Trail Passport progress backup.");
      }

      let added = 0;
      let existing = 0;
      let skipped = 0;
      const seen = new Set();
      const fallbackCompletedAt = new Date().toISOString();

      for (const entry of data.completed) {
        const segmentId = String(entry?.segmentId ?? "").trim();

        if (!segmentId || seen.has(segmentId) || invalidSegmentIds.has(segmentId)) {
          skipped += 1;
          continue;
        }

        seen.add(segmentId);
        const key = `${STORAGE_KEY_PREFIX}${segmentId}`;

        if (progress[key]) {
          existing += 1;
          continue;
        }

        progress[key] = {
          completedAt: completedAtFor(entry?.completedAt, fallbackCompletedAt)
        };
        added += 1;
      }

      const saved = added === 0 || persist();

      return { added, existing, skipped, saved };
    },

    reset() {
      progress = {};

      if (!storage) return;

      try {
        storage.removeItem(CONFIG.storageKey);
      } catch (error) {
        console.warn("Could not clear Ridge Trail completion data", error);
      }
    },

    stats(features) {
      const eligible = features.filter((feature) =>
        isCompletionEligible(feature.properties)
      );

      const done = eligible.filter((feature) =>
        isDone(feature.properties)
      );

      const totalMiles = eligible.reduce(
        (sum, feature) => sum + milesFor(feature.properties),
        0
      );

      const completedMiles = done.reduce(
        (sum, feature) => sum + milesFor(feature.properties),
        0
      );

      return {
        completedCount: done.length,
        totalCount: eligible.length,
        completedMiles,
        totalMiles,
        percent: eligible.length
          ? Math.round((done.length / eligible.length) * 100)
          : 0
      };
    }
  };
}
