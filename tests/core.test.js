import test from "node:test";
import assert from "node:assert/strict";

import { CONFIG } from "../src/config.js";
import { acknowledgeBetaNotice, isBetaNoticeAcknowledged } from "../src/beta-notice.js";
import { fetchTrailFeatures, uniqueValues, validateSegmentIds } from "../src/data.js";
import { createProgressStore, ProgressNotSavedError } from "../src/progress.js";
import {
  getFeatureEndpoints,
  isCompletionEligible,
  isSideTrail,
  milesFor,
  trailTypeLabel
} from "../src/trails.js";
import { coveredEdges, panOffset } from "../src/panel-offset.js";
import { debounce, normalizeUrl } from "../src/utils.js";

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

// Storage that can read but refuses to save, like a full or blocked browser.
class FailingStorage extends MemoryStorage {
  setItem() { throw new Error("QuotaExceededError"); }
}

// Storage that saves normally but refuses to delete, so clearing fails.
class FailingClearStorage extends MemoryStorage {
  removeItem() { throw new Error("SecurityError"); }
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

test("beta notice checkbox shows a focus ring for keyboard users only", async () => {
  const { readFile } = await import("node:fs/promises");
  const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
  const [css, main] = await Promise.all([read("../src/help.css"), read("../src/main.js")]);

  // The notice must not focus the checkbox when it opens; that is what made
  // the ring appear before anyone touched it.
  assert.ok(!/\bagree\.focus\(\)/.test(main));

  // No ring on plain :focus (mouse/touch), a visible ring on :focus-visible,
  // and a custom-drawn box so the ring lines up with it.
  assert.match(css, /\.beta-notice-check input:focus\{outline:none\}/);
  const visible = css.match(/\.beta-notice-check input:focus-visible\{([^}]*)\}/);
  assert.ok(visible, "missing :focus-visible style");
  assert.match(visible[1], /outline:\s*\d+px solid/);
  assert.match(css, /\.beta-notice-check input\{[^}]*appearance:none/);
});

test("section detail panel labels the Ridge Trail link as Details", async () => {
  const { readFile } = await import("node:fs/promises");
  const ui = await readFile(new URL("../src/ui.js", import.meta.url), "utf8");

  assert.ok(ui.includes('["BRT_Website", "Details ↗"]'));
  assert.ok(ui.includes('["Partner_Website", "Partner Website ↗"]'));
  assert.ok(ui.includes('["AllTrails_Link", "AllTrails ↗"]'));
});

test("beta notice emphasises its three key statements with <strong>", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const notice = html.slice(html.indexOf('id="betaNoticeText"'), html.indexOf('class="beta-notice-check"'));

  assert.ok(notice.includes("<p><strong>It's a test version.</strong> Things may change or not work as expected, and your progress is saved only on this device.</p>"));
  assert.ok(notice.includes("<p><strong>It's not a navigation tool.</strong> Conditions, closures, and access change, and some sections need permission. Check with the land manager before you go.</p>"));
  assert.ok(notice.includes("<p><strong>This link is just for beta testers for now.</strong></p>"));
  // The intro paragraph stays plain.
  assert.ok(notice.includes("<p>Explore the Ridge Trail"));
  assert.equal((notice.match(/<strong>/g) || []).length, 3);
});

test("beta notice intro points people to Help with the Help icon", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const intro = html.match(/<p>Explore the Ridge Trail[\s\S]*?<\/p>/)[0];
  const text = intro.replace(/<svg[\s\S]*?<\/svg>/, "(?)");

  assert.equal(text, "<p>Explore the Ridge Trail and track the sections you've hiked. Stuck or curious? Tap (?) Help for additional tips and information.</p>");
  // The icon is still the Help button's own icon, inline at text size.
  assert.match(intro, /<svg class="inline-help-icon"[^>]*aria-hidden="true"/);
});

test("beta notice checkbox lines up with the first line of its label", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../src/help.css", import.meta.url), "utf8");
  const box = css.match(/\.beta-notice-check input\{([^}]*)\}/)[1];
  const label = css.match(/\.beta-notice-check\{([^}]*)\}/)[1];

  // Top-aligned row, with the 24px box nudged so its centre sits on the
  // centre of the first 1.45-line-height line, at any number of lines.
  assert.match(label, /align-items:flex-start/);
  assert.match(label, /line-height:1\.45/);
  assert.match(box, /width:24px;height:24px/);
  assert.match(box, /margin-top:calc\(\(1\.45em - 24px\) \/ 2\)/);
});

test("desktop map controls: buttons stacked top right, key above attribution, scale bar in miles", async () => {
  const { readFile } = await import("node:fs/promises");
  const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
  const [map, desktop, mobile] = await Promise.all([
    read("../src/map.js"),
    read("../src/desktop.css"),
    read("../src/mobile-panel.css")
  ]);
  const desktopRules = desktop.slice(desktop.indexOf("@media (min-width:801px){"));

  // Scale bar: MapLibre's own, in miles, bottom left; hidden on phones.
  assert.match(map, /new ScaleControl\(\{ unit: "imperial" \}\), "bottom-left"/);
  assert.match(mobile, /\.maplibregl-ctrl-scale\{display:none\}/);

  // The map key is handed to MapLibre in the bottom-right corner, where it
  // stacks above the attribution instead of being placed with CSS.
  assert.match(map, /return legend;\s*\},\s*onRemove\(\) \{\}\s*\},\s*"bottom-right"/);

  // The four round buttons form a vertical stack at the top right.
  const actions = desktopRules.match(/\.map-wrap \.map-actions\{([^}]*)\}/)[1];
  assert.match(actions, /top:14px;right:14px;bottom:auto/);
  assert.match(actions, /flex-direction:column/);

  // Zoom gets the same 14px corner margin as the other controls.
  assert.match(desktopRules, /\.maplibregl-ctrl-top-left \.maplibregl-ctrl\{margin:14px 0 0 14px\}/);
});

// Screen boxes measured from a 390x844 phone and a 1024x768 desktop window.
const box = (left, top, right, bottom) => ({ left, top, right, bottom });

test("detail panel: phone sheet covers the bottom, desktop card covers the left", () => {
  // Phone: map fills the screen, header floats over the top, sheet over the bottom.
  assert.deepEqual(
    coveredEdges(box(0, 0, 390, 844), box(10, 412, 380, 834), box(10, 10, 380, 74)),
    { top: 74, right: 0, bottom: 432, left: 0 }
  );

  // Desktop: map starts right of the sidebar; the card sits over its left side.
  // The sidebar is beside the map, so it covers nothing.
  assert.deepEqual(
    coveredEdges(box(360, 0, 1024, 768), box(378, 284, 808, 750), box(0, 0, 360, 768)),
    { top: 0, right: 0, bottom: 0, left: 448 }
  );

  // Phone held sideways: only a thin band is left above the sheet, still used.
  assert.deepEqual(
    coveredEdges(box(0, 0, 667, 375), box(10, 177, 657, 365), box(10, 10, 657, 74)),
    { top: 74, right: 0, bottom: 198, left: 0 }
  );

  // Panel closed, or covering so much there is nowhere useful to move to.
  assert.equal(coveredEdges(box(0, 0, 390, 844), null, box(10, 10, 380, 74)), null);
  assert.equal(coveredEdges(box(360, 0, 844, 390), box(378, 18, 808, 372), box(0, 0, 360, 390)), null);
});

test("detail panel: a section is moved only when it is not fully visible, and centred in the clear area", () => {
  const covered = { top: 0, right: 0, bottom: 0, left: 448 }; // desktop, map 664x768

  // Already fully in the clear strip: no movement.
  assert.equal(panOffset(box(500, 300, 600, 400), 664, 768, covered), null);

  // Partly under the card: centred in the strip (x 456..656, y 8..760).
  assert.deepEqual(panOffset(box(300, 300, 500, 400), 664, 768, covered), [400 - 556, 350 - 384]);

  // Bigger than the clear area: still centred, never zoomed.
  assert.deepEqual(panOffset(box(0, -500, 1000, 1500), 664, 768, covered), [500 - 556, 500 - 384]);
});

test("selecting a section on the map pans without zooming; the list still frames it", async () => {
  const { readFile } = await import("node:fs/promises");
  const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
  const [main, map] = await Promise.all([read("../src/main.js"), read("../src/map.js")]);

  // Re-selecting the same section does not move the map.
  assert.match(main, /\} else if \(!alreadySelected\) \{\s*ridgeMap\.panIntoView\(feature, covered\);/);

  // The pan keeps the zoom, is short, and is instant with reduced motion.
  const pan = map.slice(map.indexOf("function panIntoView"), map.indexOf("function featureScreenBox"));
  assert.match(pan, /map\.panBy\(offset, \{\s*duration: PAN_DURATION_MS,\s*animate: !prefersReducedMotion/);
  assert.ok(!/fitBounds|zoom/i.test(pan.replace(/the zoom/g, "")), "panIntoView must not change zoom");
});

test("a failed save does not mark a section complete or change the totals", () => {
  const store = createProgressStore({ storage: new FailingStorage() });
  const section = { Trail_Type: "Primary", Segment_ID: "SEG-001", OBJECTID: 10, Calculated_Mileage: 4.2 };
  const features = [makeFeature(section)];
  const before = store.stats(features);

  assert.throws(() => store.toggle(section), ProgressNotSavedError);
  assert.equal(store.isDone(section), false);
  assert.deepEqual(store.stats(features), before);
  assert.equal(store.exportData().completed.length, 0);
});

test("a failed save does not un-mark a completed section", () => {
  const storage = new MemoryStorage();
  const section = { Trail_Type: "Primary", Segment_ID: "SEG-001", OBJECTID: 10, Calculated_Mileage: 4.2 };
  const features = [makeFeature(section)];
  createProgressStore({ storage }).toggle(section);
  const saved = storage.getItem(CONFIG.storageKey);

  // Same saved data, but now the browser refuses to save.
  const failing = new FailingStorage();
  failing.values.set(CONFIG.storageKey, saved);
  const store = createProgressStore({ storage: failing });
  const before = store.stats(features);
  const backupBefore = store.exportData().completed;

  assert.throws(() => store.toggle(section), ProgressNotSavedError);
  assert.equal(store.isDone(section), true);
  assert.deepEqual(store.stats(features), before);
  // The original completion date is kept, not replaced.
  assert.deepEqual(store.exportData().completed, backupBefore);
  assert.equal(failing.getItem(CONFIG.storageKey), saved);
});

test("with no storage available at all, completions are not kept in memory", () => {
  const store = createProgressStore({ storage: null });
  const section = { Trail_Type: "Primary", Segment_ID: "SEG-001", OBJECTID: 10 };

  assert.throws(() => store.toggle(section), ProgressNotSavedError);
  assert.equal(store.isDone(section), false);
});

test("a failed save tells the visitor, in both directions", async () => {
  const { readFile } = await import("node:fs/promises");
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const handler = main.slice(main.indexOf("function toggleComplete"), main.indexOf("function handleFiltersChange"));

  assert.match(handler, /catch \(error\) \{\s*if \(!\(error instanceof ProgressNotSavedError\)\) throw error;/);
  assert.ok(handler.includes("Couldn't save — this section wasn't marked complete. Your browser may be blocking storage or out of space."));
  assert.ok(handler.includes("Couldn't save — this section is still marked complete. Your browser may be blocking storage or out of space."));
  // Shown through the status message, which screen readers announce.
  assert.match(handler, /ui\.showStatus\(\s*wasComplete/);
});

test("a failed clear keeps every completion, on screen and in storage", () => {
  const storage = new FailingClearStorage();
  const store = createProgressStore({ storage });
  const sections = [
    { Trail_Type: "Primary", Segment_ID: "SEG-001", OBJECTID: 10, Calculated_Mileage: 4.2 },
    { Trail_Type: "Primary", Segment_ID: "SEG-002", OBJECTID: 11, Calculated_Mileage: 6.5 },
    { Trail_Type: "Primary", Segment_ID: "SEG-003", OBJECTID: 12, Calculated_Mileage: 2.0 }
  ];
  const features = sections.map((section) => makeFeature(section));
  store.toggle(sections[0]);
  store.toggle(sections[1]);

  const statsBefore = store.stats(features);
  const backupBefore = store.exportData().completed;
  const savedBefore = storage.getItem(CONFIG.storageKey);

  assert.throws(() => store.reset(), ProgressNotSavedError);

  // What the screen draws from: the same completions, count and miles.
  assert.equal(store.isDone(sections[0]), true);
  assert.equal(store.isDone(sections[1]), true);
  assert.equal(store.isDone(sections[2]), false);
  assert.deepEqual(store.stats(features), statsBefore);
  assert.deepEqual(store.exportData().completed, backupBefore);

  // Still in storage, so reloading shows the same thing.
  assert.equal(storage.getItem(CONFIG.storageKey), savedBefore);
  const reloaded = createProgressStore({ storage });
  assert.deepEqual(reloaded.stats(features), statsBefore);
});

test("a failed clear tells the visitor what happened and what to do", async () => {
  const { readFile } = await import("node:fs/promises");
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const handler = main.slice(main.indexOf("function resetProgress"), main.indexOf("function initializeMobilePanelToggle"));

  // The confirmation step is still there, before anything is cleared.
  assert.ok(handler.indexOf("window.confirm(") < handler.indexOf("progressStore.reset()"));
  assert.match(handler, /catch \(error\) \{\s*if \(!\(error instanceof ProgressNotSavedError\)\) throw error;/);
  // Shown through the status message, which screen readers announce.
  assert.ok(handler.includes('ui.showStatus(\n      "Couldn\'t clear progress — your completed sections are still saved. Try again. If it keeps happening, check that your browser isn\'t blocking storage for this site.",'));
  // "Progress reset." only after a successful clear.
  assert.ok(handler.indexOf("return;\n  }\n\n  selectedObjectId = null;") < handler.indexOf('ui.showStatus("Progress reset.")'));
});
