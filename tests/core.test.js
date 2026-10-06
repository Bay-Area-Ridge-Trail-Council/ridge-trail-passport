import test from "node:test";
import assert from "node:assert/strict";

import { CONFIG } from "../src/config.js";
import { acknowledgeBetaNotice, isBetaNoticeAcknowledged } from "../src/beta-notice.js";
import { fetchTrailFeatures, uniqueValues, validateSegmentIds } from "../src/data.js";
import { createProgressStore } from "../src/progress.js";
import {
  getFeatureEndpoints,
  isCompletionEligible,
  isSideTrail,
  milesFor,
  trailTypeLabel
} from "../src/trails.js";
import { debounce, normalizeUrl } from "../src/utils.js";

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function makeFeature(properties = {}, geometry = null) {
  return { type: "Feature", properties, geometry };
}

test("trail rules keep Primary and Restricted completion-eligible", () => {
  assert.equal(isCompletionEligible({ Trail_Type: "Primary" }), true);
  assert.equal(isCompletionEligible({ Trail_Type: "Restricted" }), true);
  assert.equal(isCompletionEligible({ Trail_Type: "Spur" }), false);
  assert.equal(isSideTrail({ Trail_Type: "Connector" }), true);
  assert.equal(isSideTrail({ Trail_Type: "Parallel" }), true);
  assert.equal(trailTypeLabel({ Trail_Type: "Restricted" }), "Primary Trail with Restricted Access");
});

test("mileage rejects invalid or negative values", () => {
  assert.equal(milesFor({ Calculated_Mileage: "5.25" }), 5.25);
  assert.equal(milesFor({ Calculated_Mileage: -2 }), 0);
  assert.equal(milesFor({ Calculated_Mileage: "not-a-number" }), 0);
});

test("endpoint extraction handles LineString and MultiLineString safely", () => {
  const line = makeFeature({}, {
    type: "LineString",
    coordinates: [[-122.5, 37.5], [-122.4, 37.6]]
  });

  assert.deepEqual(getFeatureEndpoints(line), {
    start: [37.5, -122.5],
    end: [37.6, -122.4]
  });

  const multi = makeFeature({}, {
    type: "MultiLineString",
    coordinates: [
      [[-122.5, 37.5], [-122.45, 37.55]],
      [[-122.4, 37.6], [-122.3, 37.7]]
    ]
  });

  assert.deepEqual(getFeatureEndpoints(multi), {
    start: [37.5, -122.5],
    end: [37.7, -122.3]
  });

  assert.equal(getFeatureEndpoints(makeFeature({}, {
    type: "LineString",
    coordinates: [["bad", 37.5], [-122.4, 37.6]]
  })), null);
});

test("Segment ID QA catches missing and duplicate permanent IDs", () => {
  const result = validateSegmentIds([
    makeFeature({ OBJECTID: 1, Segment_ID: "SEG-001" }),
    makeFeature({ OBJECTID: 2, Segment_ID: "SEG-001" }),
    makeFeature({ OBJECTID: 3, Segment_ID: "" })
  ]);

  assert.equal(result.valid, false);
  assert.deepEqual(result.duplicateSegmentIds, ["SEG-001"]);
  assert.deepEqual(result.missingObjectIds, [3]);
});

test("filter values are trimmed, unique, and sorted", () => {
  const features = [
    makeFeature({ County: "Marin" }),
    makeFeature({ County: " San Mateo " }),
    makeFeature({ County: "Marin" }),
    makeFeature({ County: null })
  ];

  assert.deepEqual(uniqueValues(features, "County"), ["Marin", "San Mateo"]);
});

test("completion persists only by permanent Segment ID", () => {
  const storage = new MemoryStorage();
  const store = createProgressStore({ storage });
  const primary = { Trail_Type: "Primary", Segment_ID: "SEG-001", OBJECTID: 10 };
  const sameSegmentNewObjectId = { Trail_Type: "Primary", Segment_ID: "SEG-001", OBJECTID: 999 };
  const missingSegmentId = { Trail_Type: "Primary", OBJECTID: 11 };
  const sideTrail = { Trail_Type: "Spur", Segment_ID: "SEG-200", OBJECTID: 12 };

  assert.equal(store.toggle(primary), true);
  assert.equal(store.isDone(sameSegmentNewObjectId), true);
  assert.equal(store.toggle(missingSegmentId), null);
  assert.equal(store.toggle(sideTrail), null);

  const reloaded = createProgressStore({ storage });
  assert.equal(reloaded.isDone(primary), true);

  reloaded.reset();
  assert.equal(storage.getItem(CONFIG.storageKey), null);
});

test("duplicate Segment IDs are blocked from sharing completion state", () => {
  const storage = new MemoryStorage();
  const store = createProgressStore({ storage });
  const duplicate = { Trail_Type: "Primary", Segment_ID: "SEG-DUPLICATE", OBJECTID: 20 };

  store.setInvalidSegmentIds(["SEG-DUPLICATE"]);

  assert.equal(store.toggle(duplicate), null);
  assert.equal(store.isDone(duplicate), false);
  assert.equal(storage.getItem(CONFIG.storageKey), null);
});

test("malformed saved progress is ignored instead of breaking the app", () => {
  const storage = new MemoryStorage();
  storage.setItem(CONFIG.storageKey, "{not-json");

  const store = createProgressStore({ storage });
  assert.equal(store.isDone({ Trail_Type: "Primary", Segment_ID: "SEG-001" }), false);
});

test("progress backup round-trips completed Segment IDs", () => {
  const storage = new MemoryStorage();
  const store = createProgressStore({ storage });
  const first = { Trail_Type: "Primary", Segment_ID: "SEG-001" };
  const second = { Trail_Type: "Restricted", Segment_ID: "SEG-002" };

  store.toggle(first);
  store.toggle(second);

  const backup = store.exportData();
  assert.equal(backup.app, "Ridge Trail Passport");
  assert.equal(backup.version, 1);
  assert.deepEqual(backup.completed.map((entry) => entry.segmentId), ["SEG-001", "SEG-002"]);

  store.reset();
  assert.equal(store.isDone(first), false);

  const result = store.importData(backup);
  assert.deepEqual(result, { added: 2, existing: 0, skipped: 0, saved: true });
  assert.equal(store.isDone(first), true);
  assert.equal(store.isDone(second), true);
});

test("progress import merges without removing existing or unknown Segment IDs", () => {
  const storage = new MemoryStorage();
  const store = createProgressStore({ storage });
  const existing = { Trail_Type: "Primary", Segment_ID: "SEG-001" };
  const unknown = { Trail_Type: "Primary", Segment_ID: "SEG-FUTURE" };

  store.toggle(existing);

  const result = store.importData({
    app: "Ridge Trail Passport",
    version: 1,
    exportedAt: "2026-09-14T12:00:00.000Z",
    completed: [
      { segmentId: "SEG-001", completedAt: "2026-01-01T12:00:00.000Z" },
      { segmentId: "SEG-FUTURE", completedAt: "2026-02-01T12:00:00.000Z" }
    ]
  });

  assert.deepEqual(result, { added: 1, existing: 1, skipped: 0, saved: true });
  assert.equal(store.isDone(existing), true);
  assert.equal(store.isDone(unknown), true);
});

test("progress import rejects invalid backups and skips duplicate route IDs", () => {
  const storage = new MemoryStorage();
  const store = createProgressStore({ storage });

  assert.throws(
    () => store.importData({ app: "Something Else", version: 1, completed: [] }),
    /valid Ridge Trail Passport progress backup/
  );

  store.setInvalidSegmentIds(["SEG-DUPLICATE"]);
  const result = store.importData({
    app: "Ridge Trail Passport",
    version: 1,
    completed: [
      { segmentId: "SEG-DUPLICATE" },
      { segmentId: "SEG-OK" },
      { segmentId: "SEG-OK" },
      { segmentId: "" }
    ]
  });

  assert.deepEqual(result, { added: 1, existing: 0, skipped: 3, saved: true });
  assert.equal(store.isDone({ Trail_Type: "Primary", Segment_ID: "SEG-DUPLICATE" }), false);
  assert.equal(store.isDone({ Trail_Type: "Primary", Segment_ID: "SEG-OK" }), true);
});

test("external links accept only http and https URLs", () => {
  assert.equal(normalizeUrl(" https://ridgetrail.org/path "), "https://ridgetrail.org/path");
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
  assert.equal(normalizeUrl("mailto:test@example.com"), null);
  assert.equal(normalizeUrl("not a url"), null);
});

test("debounce runs once after a pause and can be cancelled", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const calls = [];
  const debounced = debounce((value) => calls.push(value), 200);

  debounced("r");
  t.mock.timers.tick(100);
  debounced("ri");
  t.mock.timers.tick(100);
  debounced("rid");
  t.mock.timers.tick(199);
  assert.deepEqual(calls, []);

  t.mock.timers.tick(1);
  assert.deepEqual(calls, ["rid"]);

  debounced("ridge");
  debounced.cancel();
  t.mock.timers.tick(500);
  assert.deepEqual(calls, ["rid"]);
});

test("trail query asks ArcGIS for coordinates rounded to the configured precision", async (t) => {
  const requested = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requested.push(new URL(url));
    return { ok: true, json: async () => ({ type: "FeatureCollection", features: [] }) };
  });
  globalThis.window ??= globalThis;

  await fetchTrailFeatures();

  assert.equal(CONFIG.geometryPrecision, 6);
  assert.equal(requested.length, 1);
  assert.equal(requested[0].searchParams.get("geometryPrecision"), "6");
  assert.equal(requested[0].searchParams.get("outSR"), "4326");
});

test("beta notice is shown until acknowledged, and again after a version bump", () => {
  const storage = new MemoryStorage();

  assert.equal(isBetaNoticeAcknowledged(storage), false);
  assert.equal(acknowledgeBetaNotice(storage), true);
  assert.equal(isBetaNoticeAcknowledged(storage), true);
  assert.equal(
    storage.getItem(CONFIG.betaNotice.storageKey),
    String(CONFIG.betaNotice.version)
  );

  // An acknowledgment of an older notice does not count.
  storage.setItem(CONFIG.betaNotice.storageKey, String(CONFIG.betaNotice.version - 1));
  assert.equal(isBetaNoticeAcknowledged(storage), false);

  // Acknowledging does not touch saved progress.
  assert.equal(storage.getItem(CONFIG.storageKey), null);
});

test("beta notice never blocks the app when storage is unavailable", () => {
  const broken = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); }
  };

  assert.equal(isBetaNoticeAcknowledged(broken), false);
  assert.equal(acknowledgeBetaNotice(broken), false);
  assert.equal(isBetaNoticeAcknowledged(null), false);
  assert.equal(acknowledgeBetaNotice(null), false);
});

test("index.html keeps the beta out of search results and matches the beta notice settings", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(html, /<meta name="robots" content="noindex, nofollow"\s*\/?>/);

  // The early script in <head> must use the same storage key and version as
  // CONFIG, or the notice would flash or be skipped on load.
  const head = html.slice(0, html.indexOf("</head>"));
  assert.ok(head.includes(`"${CONFIG.betaNotice.storageKey}"`));
  assert.match(head, new RegExp(`>=\\s*${CONFIG.betaNotice.version}\\b`));

  // The feedback form address lives in config.js, not in the markup.
  assert.ok(!html.includes(CONFIG.feedbackFormUrl));
  assert.match(CONFIG.feedbackFormUrl, /^https:\/\/docs\.google\.com\/forms\//);
});

test("Clear all progress lives with the backup actions, not among the map controls", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  const between = (start, end) => {
    const from = html.indexOf(start);
    return from === -1 ? "" : html.slice(from, html.indexOf(end, from));
  };
  const mapControls = between('<div class="map-actions">', '<div class="legend"');
  const backupActions = between('<div class="help-backup-actions">', "</div>");

  assert.ok(mapControls.length > 0 && backupActions.length > 0);
  assert.ok(!mapControls.includes('id="resetBtn"'), "Reset must not be in the map controls");
  assert.match(backupActions, /id="resetBtn"[^>]*>Clear all progress</);
  assert.ok(backupActions.includes('id="exportProgressBtn"'));
});

test("status messages show in front of the Help panel but behind the beta notice", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = (await Promise.all(
    ["styles.css", "help.css"].map((name) => readFile(new URL(`../src/${name}`, import.meta.url), "utf8"))
  )).join("\n");
  const zIndexOf = (selector) => {
    const rule = css.match(new RegExp(`(^|\\n)${selector.replace(".", "\\.")}\\{[^}]*z-index:(\\d+)`));
    assert.ok(rule, `no z-index found for ${selector}`);
    return Number(rule[2]);
  };

  // "Progress reset." appears while Help is open (Clear all progress lives there).
  assert.ok(zIndexOf(".status") > zIndexOf(".help-backdrop"));
  assert.ok(zIndexOf(".status") < zIndexOf(".beta-notice-backdrop"));
});
