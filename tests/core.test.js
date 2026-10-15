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
import { carryOverAppLayers } from "../src/style-swap.js";

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


test("a failed import save adds nothing, now or later", () => {
  // A browser that refuses to save until saving is switched back on.
  class SwitchableStorage extends MemoryStorage {
    constructor() { super(); this.failSaves = false; }
    setItem(key, value) {
      if (this.failSaves) throw new Error("QuotaExceededError");
      super.setItem(key, value);
    }
  }

  const storage = new SwitchableStorage();
  const store = createProgressStore({ storage });
  const section = (id) => ({ Trail_Type: "Primary", Segment_ID: id, OBJECTID: id.length, Calculated_Mileage: 3 });
  const features = ["SEG-001", "SEG-002", "SEG-003", "SEG-004"].map((id) => makeFeature(section(id)));
  store.toggle(section("SEG-001"));

  const statsBefore = store.stats(features);
  const backupBefore = store.exportData().completed;
  const savedBefore = storage.getItem(CONFIG.storageKey);

  storage.failSaves = true;
  const result = store.importData({
    app: "Ridge Trail Passport",
    version: 1,
    completed: [{ segmentId: "SEG-001" }, { segmentId: "SEG-002" }, { segmentId: "SEG-003" }]
  });

  // Reported as not saved; nothing new shows, nothing existing is removed.
  assert.equal(result.saved, false);
  assert.equal(store.isDone(section("SEG-001")), true);
  assert.equal(store.isDone(section("SEG-002")), false);
  assert.equal(store.isDone(section("SEG-003")), false);
  assert.deepEqual(store.stats(features), statsBefore);
  assert.deepEqual(store.exportData().completed, backupBefore);
  assert.equal(storage.getItem(CONFIG.storageKey), savedBefore);

  // A later successful save does not quietly store the failed import.
  storage.failSaves = false;
  store.toggle(section("SEG-004"));
  const reloaded = createProgressStore({ storage });
  assert.deepEqual(
    reloaded.exportData().completed.map((entry) => entry.segmentId),
    ["SEG-001", "SEG-004"]
  );
});

test("a failed import save tells the visitor nothing was imported", async () => {
  const { readFile } = await import("node:fs/promises");
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");

  assert.match(
    main,
    /if \(!result\.saved\) \{\s*throw new Error\(\s*"Couldn't save — nothing was imported\. Your browser may be blocking storage or out of space\."/
  );
  // Shown in the backup section's status message, which screen readers announce.
  assert.match(main, /error\?\.message \|\| "Could not import that progress backup\.",\s*\{ isError: true \}/);
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

test("service worker: hashed files are cache-first, the list is only filled in at build time", async () => {
  const { readFile } = await import("node:fs/promises");
  const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
  const [sw, viteConfig] = await Promise.all([read("../public/sw.js"), read("../vite.config.js")]);

  // As committed (and in `npm run dev`), the list is empty: nothing extra is
  // cached and no list from an earlier build can linger.
  assert.match(sw, /const BUILD_ID = \/\* build:id \*\/ "dev" \/\* end \*\/;/);
  assert.match(sw, /const BUILD_ASSETS = \/\* build:assets \*\/ \[\] \/\* end \*\/;/);
  assert.match(sw, /^\/\/ NOTE: THIS FILE IS NOT EXACTLY WHAT SHIPS\./);

  // The hashed-file pattern matches Vite's output and nothing with a stable name.
  const swPattern = new RegExp(sw.match(/const HASHED_ASSET = \/(.+)\/;/)[1]);
  for (const path of ["/assets/index-D-uGn5bA.css", "/assets/index-DvNcw7dq.js", "/assets/maplibre-gl-worker-MfjJLauD.js"]) {
    assert.ok(swPattern.test(path), `${path} should be cache-first`);
  }
  for (const path of ["/", "/index.html", "/sw.js", "/ridge-trail-logo.png", "/manifest.webmanifest",
    "/ridge-trail-app-icon-192.png", "/src/main.js", "/assets/logo.png"]) {
    assert.ok(!swPattern.test(path), `${path} must stay network-first`);
  }

  // The build step uses the same pattern (without the leading slash).
  const buildPattern = viteConfig.match(/const HASHED_ASSET = \/\^(.+)\/;/)[1];
  assert.equal("\\/" + buildPattern, swPattern.source);

  // Other sites (tiles, basemap style, ArcGIS, photos) are still never touched.
  assert.ok(sw.includes("if (url.origin !== self.location.origin) return;"));
});

test("a slow trail response is still used, not thrown away as a timeout", async (t) => {
  globalThis.window ??= globalThis;
  window.__sectionsPromise = undefined;
  t.mock.timers.enable({ apis: ["setTimeout"] });

  // Answers after 40 seconds, like ArcGIS on a very slow connection. Stops
  // early only if the app cancels the request.
  t.mock.method(globalThis, "fetch", (_url, options = {}) =>
    new Promise((resolve, reject) => {
      setTimeout(() => resolve({
        ok: true,
        json: async () => ({ type: "FeatureCollection", features: [makeFeature({ OBJECTID: 1 })] })
      }), 40000);
      options.signal?.addEventListener("abort", () =>
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
      );
    })
  );

  const result = fetchTrailFeatures();
  t.mock.timers.tick(40000);
  const features = await result;

  assert.equal(features.length, 1);
});

test("the trail request started by index.html is used once, then the app asks again itself", async (t) => {
  globalThis.window ??= globalThis;
  const requested = [];
  const response = (id) => ({
    ok: true,
    json: async () => ({ type: "FeatureCollection", features: [makeFeature({ OBJECTID: id })] })
  });
  t.mock.method(globalThis, "fetch", async (url) => {
    requested.push(new URL(url));
    return response(2);
  });

  window.__sectionsPromise = Promise.resolve(response(1));
  const first = await fetchTrailFeatures();
  assert.equal(first[0].properties.OBJECTID, 1);
  assert.equal(requested.length, 0, "the early request is used instead of a second one");

  // Later refreshes (coming back online, reopening the app) ask ArcGIS afresh.
  const second = await fetchTrailFeatures();
  assert.equal(second[0].properties.OBJECTID, 2);
  assert.equal(requested.length, 1);

  // Without the early request (script removed or failed), the app asks itself.
  window.__sectionsPromise = undefined;
  await fetchTrailFeatures();
  assert.equal(requested.length, 2);
});

test("a failed early trail request is reported as a failure", async (t) => {
  globalThis.window ??= globalThis;
  t.mock.method(globalThis, "fetch", async () => assert.fail("should not ask again"));

  window.__sectionsPromise = Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(fetchTrailFeatures(), /HTTP 503/);
});

test("index.html starts the trail request early, using the address from config.js", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fillStartupAddresses } = await import("../vite.config.js");
  const { trailQueryUrl } = await import("../src/data.js");
  const source = await readFile(new URL("../index.html", import.meta.url), "utf8");

  // The address is written down once, in config.js, not in index.html.
  assert.ok(!source.includes("arcgis.com"));
  assert.ok(!source.includes("openfreemap.org"));

  const html = fillStartupAddresses(source);
  const head = html.slice(0, html.indexOf("</head>"));
  const script = head.indexOf("window.__sectionsPromise");

  assert.ok(script > 0, "the early request is in <head>");
  assert.ok(head.includes(JSON.stringify(trailQueryUrl())), "it asks for exactly what data.js would");

  for (const address of [CONFIG.featureService, CONFIG.basemap.styleUrl]) {
    const link = `<link rel="preconnect" href="${new URL(address).origin}" crossorigin />`;
    assert.ok(head.includes(link), `${link} is in <head>`);
    assert.ok(head.indexOf(link) < script, "preconnect comes before the early request");
  }

  // A future Content-Security-Policy would block inline scripts without this.
  assert.match(source, /Content-Security-Policy[\s\S]*nonce[\s\S]*hash/);
});

test("service worker install caches only what the app needs offline; the logo and icons wait until asked", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");

  const listeners = {};
  const fetched = [];
  const cached = new Map();
  const cache = {
    addAll: async () => {},
    put: async (key, value) => { cached.set(String(key), value); },
    match: async (key) => cached.get(String(key))
  };
  const fakeSelf = {
    registration: { scope: "https://example.org/" },
    location: { origin: "https://example.org" },
    addEventListener: (type, listener) => { listeners[type] = listener; },
    skipWaiting: async () => {},
    clients: { claim: async () => {} }
  };
  const fakeCaches = { open: async () => cache, delete: async () => true, keys: async () => [] };
  const fakeFetch = async (path) => {
    fetched.push(String(path));
    return new Response("<!doctype html>", { status: 200 });
  };
  new Function("self", "caches", "fetch", source)(fakeSelf, fakeCaches, fakeFetch);

  const run = async (type, data) => {
    let work;
    listeners[type]({ data, waitUntil: (promise) => { work = promise; } });
    await work;
  };

  await run("install");
  assert.deepEqual(fetched, ["./"], "install fetches only the page (plus the build's own files)");

  const extras = ["./manifest.webmanifest", "./ridge-trail-logo.png", "./ridge-trail-app-icon-180.png",
    "./ridge-trail-app-icon-192.png", "./ridge-trail-app-icon-512.png"];
  await run("message", "cache-extras");
  assert.deepEqual(fetched.slice(1).sort(), [...extras].sort());
  for (const path of extras) assert.ok(cached.has(path), `${path} is saved for offline use`);

  // Asking again (every visit) does not download them again.
  await run("message", "cache-extras");
  assert.equal(fetched.length, 1 + extras.length);
});

// The map starts on a plain style with the trail drawn, then swaps in the
// basemap. These are the style objects MapLibre hands to transformStyle.
function plainStyleWithTrail() {
  return {
    version: 8,
    sources: {
      "ridge-trail": { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      "my-location": { type: "geojson", data: { type: "FeatureCollection", features: [] } }
    },
    layers: [
      { id: "fallback-background", type: "background" },
      { id: "ridge-trail-selected-highlight", type: "line", source: "ridge-trail" },
      { id: "ridge-trail-side", type: "line", source: "ridge-trail" },
      { id: "ridge-trail-main", type: "line", source: "ridge-trail" },
      { id: "my-location", type: "circle", source: "my-location" }
    ]
  };
}

function basemapStyle() {
  return {
    version: 8,
    sources: { openmaptiles: { type: "vector", url: "https://example.org/tiles.json" } },
    layers: [
      { id: "background", type: "background" },
      { id: "roads", type: "line", source: "openmaptiles" }
    ]
  };
}

test("swapping in the basemap keeps the trail layers, drawn on top", () => {
  const previous = plainStyleWithTrail();
  const result = carryOverAppLayers(previous, basemapStyle(), ["ridge-trail", "my-location"]);

  assert.deepEqual(result.layers.map((layer) => layer.id), [
    "background",
    "roads",
    "ridge-trail-selected-highlight",
    "ridge-trail-side",
    "ridge-trail-main",
    "my-location"
  ]);
  assert.equal(result.sources["ridge-trail"], previous.sources["ridge-trail"], "trail data is carried over as is");
  assert.ok(result.sources["my-location"]);
  assert.ok(result.sources.openmaptiles, "basemap sources are kept");
});

test("carrying the trail layers over twice never duplicates them", () => {
  const appSources = ["ridge-trail", "my-location"];
  const once = carryOverAppLayers(plainStyleWithTrail(), basemapStyle(), appSources);
  const twice = carryOverAppLayers(once, once, appSources);

  assert.deepEqual(twice.layers.map((layer) => layer.id), once.layers.map((layer) => layer.id));
  assert.deepEqual(Object.keys(twice.sources).sort(), Object.keys(once.sources).sort());
});

test("with no current style, the basemap style is used unchanged", () => {
  const next = basemapStyle();
  assert.equal(carryOverAppLayers(undefined, next, ["ridge-trail"]), next);
});

// --- Service worker: basemap style, sprite and glyphs -------------------------

const OFM = "https://tiles.openfreemap.org";
const STYLE_URL = `${OFM}/styles/liberty`;

function basemapStyleDocument(spriteFolder = "ofm_f384", fontsFolder = "fonts") {
  return {
    version: 8,
    sprite: `${OFM}/sprites/${spriteFolder}/ofm`,
    glyphs: `${OFM}/${fontsFolder}/{fontstack}/{range}.pbf`,
    sources: { openmaptiles: { type: "vector", url: `${OFM}/planet` } },
    layers: []
  };
}

// Runs public/sw.js (with the style address filled in, as the build does)
// against in-memory caches and a stand-in network.
async function startServiceWorker({ cachedStyle, network }) {
  const { readFile } = await import("node:fs/promises");
  const source = (await readFile(new URL("../public/sw.js", import.meta.url), "utf8"))
    .replace(/\/\* build:basemap-style \*\/.*?\/\* end \*\//, JSON.stringify(STYLE_URL));

  const stores = new Map();
  const store = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  const fakeCaches = {
    open: async (name) => {
      const entries = store(name);
      return {
        match: async (key) => entries.get(typeof key === "string" ? key : key.url)?.clone(),
        put: async (key, response) => { entries.set(typeof key === "string" ? key : key.url, response); },
        keys: async () => [...entries.keys()].map((url) => ({ url })),
        delete: async (key) => entries.delete(typeof key === "string" ? key : key.url)
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name)
  };

  const basemap = store("ridge-trail-passport-basemap");
  if (cachedStyle) basemap.set(STYLE_URL, Response.json(cachedStyle));

  const fetched = [];
  const fakeFetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    fetched.push(url);
    return network(url);
  };

  const listeners = {};
  const fakeSelf = {
    registration: { scope: "https://example.org/" },
    location: { origin: "https://example.org" },
    addEventListener: (type, listener) => { listeners[type] = listener; },
    skipWaiting: async () => {},
    clients: { claim: async () => {} }
  };
  new Function("self", "caches", "fetch", source)(fakeSelf, fakeCaches, fakeFetch);
  // Let it read the cached style, as it does when it starts.
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Sends one request through the service worker. answered is false when it
  // was left to go straight to the network.
  async function request(url) {
    let answer;
    const background = [];
    listeners.fetch({
      request: new Request(url),
      respondWith: (promise) => { answer = promise; },
      waitUntil: (promise) => { background.push(promise); }
    });
    if (!answer) return { answered: false };
    const response = await answer;
    await Promise.all(background);
    return { answered: true, response };
  }

  return { request, fetched, basemap };
}

const GLYPH_URL = `${OFM}/fonts/Noto%20Sans%20Regular/0-255.pbf`;
const GLYPH_URL_2 = `${OFM}/fonts/Noto%20Sans%20Bold/8192-8447.pbf`;
const SPRITE_FILES = ["@2x.json", "@2x.png", ".json", ".png"].map((end) => `${OFM}/sprites/ofm_f384/ofm${end}`);

test("service worker: map tiles, the tile list, hillshade and ArcGIS go straight to the network", async () => {
  const sw = await startServiceWorker({
    cachedStyle: basemapStyleDocument(),
    network: async () => assert.fail("nothing here should be fetched by the service worker")
  });

  for (const url of [
    // Vector tiles are .pbf like glyphs, but from the tile address, so never cached.
    `${OFM}/planet/20250101_001001_pt/9/81/197.pbf`,
    `${OFM}/planet/20250101_001001_pt/14/2621/6331.pbf`,
    `${OFM}/planet`,
    `${OFM}/natural_earth/ne2sr/5/5/12.png`,
    `${OFM}/fonts/Noto%20Sans%20Regular/not-a-range.pbf`,
    `${CONFIG.featureService}/query?where=1%3D1&f=geojson`,
    `${CONFIG.featureService}/12/attachments?f=json`
  ]) {
    assert.equal((await sw.request(url)).answered, false, `${url} must not be handled`);
  }
  assert.deepEqual([...sw.basemap.keys()], [STYLE_URL], "nothing new was cached");
});

test("service worker: style, sprite and glyphs come from the cache, then are refreshed in the background", async () => {
  const sw = await startServiceWorker({
    cachedStyle: basemapStyleDocument(),
    network: async (url) => url === STYLE_URL
      ? Response.json({ ...basemapStyleDocument(), name: "fresh" })
      : new Response(`fresh ${url}`)
  });
  for (const url of [...SPRITE_FILES, GLYPH_URL, GLYPH_URL_2]) sw.basemap.set(url, new Response(`old ${url}`));

  const style = await sw.request(STYLE_URL);
  assert.equal(style.answered, true);
  assert.equal((await style.response.json()).name, undefined, "the cached copy is served");
  assert.equal((await sw.basemap.get(STYLE_URL).clone().json()).name, "fresh", "and replaced for next time");

  for (const url of [...SPRITE_FILES, GLYPH_URL, GLYPH_URL_2]) {
    const result = await sw.request(url);
    assert.equal(result.answered, true, `${url} is handled`);
    assert.equal(await result.response.text(), `old ${url}`);
    assert.equal(await sw.basemap.get(url).clone().text(), `fresh ${url}`);
  }
});

test("service worker: when offline, the cached style, sprite and glyphs keep being served", async () => {
  const sw = await startServiceWorker({
    cachedStyle: basemapStyleDocument(),
    network: async () => { throw new TypeError("Failed to fetch"); }
  });
  sw.basemap.set(GLYPH_URL, new Response("glyphs"));

  assert.equal((await (await sw.request(STYLE_URL)).response.json()).sprite, basemapStyleDocument().sprite);
  assert.equal(await (await sw.request(GLYPH_URL)).response.text(), "glyphs");
  assert.ok(sw.basemap.has(STYLE_URL) && sw.basemap.has(GLYPH_URL), "nothing is lost");

  // A server error is treated the same way: the cached copy stays.
  const failing = await startServiceWorker({
    cachedStyle: basemapStyleDocument(),
    network: async () => new Response("down", { status: 503 })
  });
  await failing.request(STYLE_URL);
  assert.equal((await failing.basemap.get(STYLE_URL).clone().json()).sprite, basemapStyleDocument().sprite);
});

test("service worker: on the first visit the style is fetched and kept, and its sprite and glyphs are then cached", async () => {
  const sw = await startServiceWorker({
    cachedStyle: null,
    network: async (url) => url === STYLE_URL ? Response.json(basemapStyleDocument()) : new Response(`from ${url}`)
  });

  const style = await sw.request(STYLE_URL);
  assert.equal((await style.response.json()).sprite, basemapStyleDocument().sprite);
  assert.ok(sw.basemap.has(STYLE_URL));

  const glyphs = await sw.request(GLYPH_URL);
  assert.equal(glyphs.answered, true);
  assert.equal(await glyphs.response.text(), `from ${GLYPH_URL}`);
  assert.ok(sw.basemap.has(GLYPH_URL));
});

test("service worker: a new style version removes cached sprite and glyph files it no longer uses", async () => {
  const sw = await startServiceWorker({
    cachedStyle: basemapStyleDocument("ofm_f384", "fonts"),
    network: async (url) => url === STYLE_URL
      ? Response.json(basemapStyleDocument("ofm_f999", "fonts-v2"))
      : new Response(url)
  });
  for (const url of [...SPRITE_FILES, GLYPH_URL, GLYPH_URL_2]) sw.basemap.set(url, new Response("old"));

  // This visit still gets the cached style (the new one applies next visit).
  await sw.request(STYLE_URL);
  assert.deepEqual([...sw.basemap.keys()], [STYLE_URL], "old sprite and glyphs are removed");

  // The new style's files are cached from now on; the old ones are not.
  const newSprite = `${OFM}/sprites/ofm_f999/ofm@2x.png`;
  const newGlyphs = `${OFM}/fonts-v2/Noto%20Sans%20Regular/0-255.pbf`;
  assert.equal((await sw.request(newSprite)).answered, true);
  assert.equal((await sw.request(newGlyphs)).answered, true);
  assert.equal((await sw.request(SPRITE_FILES[0])).answered, false);
  assert.deepEqual([...sw.basemap.keys()].sort(), [newGlyphs, newSprite, STYLE_URL].sort());
});

test("service worker: the basemap cache is separate from the app's files and survives a new deploy", async () => {
  const { readFile } = await import("node:fs/promises");
  const [sw, viteConfig] = await Promise.all([
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.js", import.meta.url), "utf8")
  ]);

  const shellPrefix = sw.match(/const CACHE_PREFIX = "([^"]+)";/)[1];
  const basemapCache = sw.match(/const BASEMAP_CACHE = "([^"]+)";/)[1];
  // activate deletes every cache starting with the app's prefix.
  assert.ok(!basemapCache.startsWith(shellPrefix));

  // The style address is written down once, in config.js; the build fills it in.
  assert.match(sw, /const BASEMAP_STYLE_URL = \/\* build:basemap-style \*\/ "" \/\* end \*\/;/);
  assert.ok(viteConfig.includes("JSON.stringify(CONFIG.basemap.styleUrl)"));
  const code = sw.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.ok(!code.includes("openfreemap.org"), "no basemap address is written into sw.js code");
});

// A tiny stand-in for the page, just enough for createUI() to run in Node.
function fakeSearchPage() {
  const elements = new Map();

  function element(id) {
    if (!elements.has(id)) {
      const listeners = {};
      elements.set(id, {
        id,
        value: "",
        checked: false,
        hidden: false,
        focused: false,
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener(type, listener) {
          (listeners[type] ||= []).push(listener);
        },
        dispatch(type) {
          for (const listener of listeners[type] || []) listener({ type });
        },
        focus() { this.focused = true; }
      });
    }
    return elements.get(id);
  }

  globalThis.window = {};
  globalThis.document = { getElementById: element };
  return element;
}

function searchTestFeatures() {
  return [
    makeFeature({ OBJECTID: 1, Section_Name: "Mount Tamalpais", County: "Marin", Region: "North Bay", Trail_Type: "Primary", Segment_ID: "A" }),
    makeFeature({ OBJECTID: 2, Section_Name: "Mount Diablo", County: "Contra Costa", Region: "East Bay", Trail_Type: "Primary", Segment_ID: "B" }),
    makeFeature({ OBJECTID: 3, Section_Name: "Skyline", County: "Marin", Region: "North Bay", Trail_Type: "Primary", Segment_ID: "C" })
  ];
}

test("search narrows the list but never hides sections from the map; other filters still apply to both", async (t) => {
  t.after(() => { delete globalThis.window; delete globalThis.document; });
  const element = fakeSearchPage();
  const { createUI } = await import("../src/ui.js");
  const progressStore = createProgressStore(new MemoryStorage());
  const ui = createUI({ progressStore });
  const ids = (list) => list.map((feature) => feature.properties.OBJECTID);
  const features = searchTestFeatures();

  element("search").value = "mount";
  assert.deepEqual(ids(ui.filterFeatures(features)), [1, 2]);
  assert.deepEqual(ids(ui.filterFeatures(features, { includeSearch: false })), [1, 2, 3]);

  // County is unchanged: it still narrows both the list and the map.
  element("county").value = "Marin";
  assert.deepEqual(ids(ui.filterFeatures(features)), [1]);
  assert.deepEqual(ids(ui.filterFeatures(features, { includeSearch: false })), [1, 3]);

  // The map is drawn from the search-free list.
  const main = await (await import("node:fs/promises")).readFile(new URL("../src/main.js", import.meta.url), "utf8");
  assert.match(main, /function visibleFeatures\(\) \{\s*return ui\.filterFeatures\(features, \{ includeSearch: false \}\);/);
  assert.match(main, /const visible = visibleFeatures\(\);\s*ridgeMap\.render\(visible, selectedObjectId\);/);
});

test("typing in search updates the list only; County, Region and Uncompleted only update the map", async (t) => {
  t.after(() => { delete globalThis.window; delete globalThis.document; });
  const element = fakeSearchPage();
  const { createUI } = await import("../src/ui.js");
  const calls = [];
  createUI({
    progressStore: createProgressStore(new MemoryStorage()),
    onSearchInput: () => calls.push("list"),
    onFiltersChange: () => calls.push("filters")
  });

  element("search").value = "mount";
  element("search").dispatch("input");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(calls, ["list"]);

  for (const id of ["county", "region", "unfinished"]) element(id).dispatch("change");
  assert.deepEqual(calls, ["list", "filters", "filters", "filters"]);
});

test("search clear button: shown only with a query, clears just the search, and returns focus", async (t) => {
  t.after(() => { delete globalThis.window; delete globalThis.document; });
  const element = fakeSearchPage();
  const { createUI } = await import("../src/ui.js");
  const calls = [];
  createUI({
    progressStore: createProgressStore(new MemoryStorage()),
    onSearchInput: () => calls.push("list"),
    onFiltersChange: () => calls.push("filters")
  });
  const search = element("search");
  const clear = element("searchClear");

  search.value = "mount";
  search.dispatch("input");
  assert.equal(clear.hidden, false);

  element("county").value = "Marin";
  element("region").value = "North Bay";
  element("unfinished").checked = true;

  clear.dispatch("click");
  assert.equal(search.value, "");
  assert.equal(clear.hidden, true);
  assert.equal(search.focused, true);
  assert.deepEqual(calls, ["list", "list"], "clearing refreshes the list and nothing else");
  assert.equal(element("county").value, "Marin");
  assert.equal(element("region").value, "North Bay");
  assert.equal(element("unfinished").checked, true);

  // Deleting the text by hand also hides the button.
  search.value = "m";
  search.dispatch("input");
  search.value = "";
  search.dispatch("input");
  assert.equal(clear.hidden, true);
});

test("search clear button: labelled, a real button, starts hidden, and never covers typed text", async () => {
  const { readFile } = await import("node:fs/promises");
  const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
  const [html, css] = await Promise.all([read("../index.html"), read("../src/styles.css")]);

  assert.match(html, /<button id="searchClear" class="search-clear" type="button" aria-label="Clear search"[^>]* hidden>/);
  assert.match(css, /\.search-field #search\{padding-right:42px\}/);
  assert.match(css, /\.search-clear\{[^}]*right:4px;[^}]*width:32px;/);
  assert.match(css, /#search::-webkit-search-cancel-button\{-webkit-appearance:none;appearance:none\}/);
});

test("phone tab bar: tabs come from one list, Map first and shown by default", async () => {
  const { readFile } = await import("node:fs/promises");
  const { TABS, DEFAULT_TAB } = await import("../src/tab-bar.js");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.deepEqual(TABS.map((tab) => tab.id), ["map", "sections"]);
  assert.deepEqual(TABS.map((tab) => tab.label), ["Map", "Sections"]);
  assert.equal(DEFAULT_TAB, "map");

  // The Map tab shows the map itself; every other tab names content in
  // index.html that is marked as a tab panel.
  assert.equal(TABS[0].panel, null);
  for (const tab of TABS.slice(1)) {
    assert.match(html, new RegExp(`id="${tab.panel}" data-tab-panel`));
  }
  assert.match(html, /<aside id="sectionsPanel" data-tab-panel>/);
  assert.match(html, /<nav class="tab-bar" id="tabBar" aria-label="Main"><\/nav>/);

  // The detail sheet can take focus after a section is tapped in the list.
  assert.match(html, /<section class="sheet" id="sheet" aria-labelledby="sheetTitle" tabindex="-1">/);

  // Every icon has a part that fills in when its tab is active.
  for (const tab of TABS) assert.match(tab.icon, /class="tab-icon-shape"/);

  // The old toggle stays in the page (so the change can be undone) but hidden.
  assert.match(html, /id="mobilePanelToggle"/);
  assert.match(html, /<div id="mobileBrowserContent">/);
});

test("tapping a section in the list switches to the Map tab before selecting it", async () => {
  const { readFile } = await import("node:fs/promises");
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");

  // selectFeature measures the screen straight away, so the map must be
  // showing first.
  const fromList = main.slice(
    main.indexOf("function selectFeatureFromList("),
    main.indexOf("function initializeHelpPanel(")
  );
  assert.match(
    fromList,
    /\{\s*tabBar\?\.showTab\("map", \{ moveFocus: false \}\);\s*selectFeature\(feature, options\);/
  );
  // Then, on phones only, focus goes to the detail sheet; the search text is
  // not touched.
  assert.match(fromList, /if \(tabBar\?\.isShowing\(\)\) \$\("sheet"\)\.focus\(\{ preventScroll: true \}\);/);
  assert.ok(!/search/i.test(fromList.replace(/\/\/.*$/gm, "")));
  assert.match(main, /onSelect: selectFeatureFromList,/);
  // Map taps already happen on the Map tab.
  assert.match(main, /createRidgeMap\(\{\s*onSelect: selectFeature,/);

  // Home also returns to the Map tab; the old dropdown class is gone.
  const goHome = main.slice(main.indexOf("function goHome()"), main.indexOf("function toggleComplete("));
  assert.match(goHome, /tabBar\?\.showTab\("map"\);/);
  assert.ok(!main.includes("mobile-panel-open"));
});

test("phone layout keeps the map sized and draws the tab bar as specified", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../src/mobile-panel.css", import.meta.url), "utf8");
  const phone = css.slice(css.indexOf("@media (max-width:800px){"), css.indexOf("@media (max-width:520px)"));
  const rule = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = phone.match(new RegExp(`(?:^|[}\\s])${escaped}\\{([^}]*)\\}`));
    assert.ok(match, `missing rule ${selector}`);
    return match[1];
  };

  // The map is never removed from the layout, only made invisible under
  // another tab.
  assert.ok(!/(#map|\.map-wrap)[^{]*\{[^}]*display:none/.test(phone));
  assert.match(phone, /#app\[data-active-tab\]:not\(\[data-active-tab="map"\]\) :is\(#map,[^)]*\)\{visibility:hidden\}/);

  // Inactive tab content is hidden, not collapsed, so scroll position survives.
  assert.match(rule("[data-tab-panel]"), /visibility:hidden/);
  assert.ok(!/display:none/.test(rule("[data-tab-panel]")));
  assert.match(rule("[data-tab-panel].tab-panel-active"), /visibility:visible/);
  assert.match(rule(".sidebar-scroll"), /overflow-y:auto/);

  // County and Region filters are shown again on phones.
  assert.ok(!/\.row\{display:none\}/.test(phone));

  // Bar: 56px plus the home-indicator area, hairline top border, no shadow,
  // opaque unless blur is supported.
  assert.match(phone, /--tab-bar-height:calc\(56px \+ env\(safe-area-inset-bottom\)\)/);
  const bar = rule(".tab-bar");
  assert.match(bar, /padding-bottom:env\(safe-area-inset-bottom\)/);
  assert.match(bar, /background:var\(--paper\)/);
  assert.match(bar, /border-top:1px solid var\(--line\)/);
  assert.ok(!/box-shadow/.test(bar));
  assert.match(
    phone,
    /@supports \(\(-webkit-backdrop-filter:blur\(20px\)\) or \(backdrop-filter:blur\(20px\)\)\)\{\s*\.tab-bar\{background:rgba\(255,255,255,\.9[2-5]\);-webkit-backdrop-filter:blur\(20px\);backdrop-filter:blur\(20px\)\}/
  );

  // Equal-width, full-height tabs; active state is never color alone.
  assert.match(rule(".tab-btn"), /flex:1 1 0;min-width:0;height:100%/);
  assert.match(rule('.tab-btn[aria-selected="true"]'), /color:[^;]+;font-weight:800/);
  assert.match(rule('.tab-btn[aria-selected="true"] .tab-icon-shape'), /fill:currentColor/);

  // The map area ends at the top of the bar (the panel-offset code needs no
  // change), and the sheet and hint sit at the bottom of the map area. The
  // sheet is docked on the bar: full width, hairline border, top corners only.
  assert.match(rule(".map-wrap"), /bottom:var\(--tab-bar-height\)/);
  assert.match(rule(".map-hint"), /bottom:14px/);
  const sheet = rule(".sheet");
  assert.match(sheet, /left:0;right:0;bottom:0/);
  assert.match(sheet, /border:1px solid var\(--line\);border-bottom:0;border-radius:var\(--radius\) var\(--radius\) 0 0/);

  // The old dropdown toggle is hidden everywhere.
  assert.match(css, /^\.mobile-panel-toggle\{display:none\}/m);
  assert.ok(!/mobile-panel-open/.test(css));
});

test("phone Map tab has a slim one-row header styled like the tab bar", async () => {
  const { readFile } = await import("node:fs/promises");
  const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
  const [html, css, ui] = await Promise.all([
    read("../index.html"),
    read("../src/mobile-panel.css"),
    read("../src/ui.js")
  ]);
  const phone = css.slice(css.indexOf("@media (max-width:800px){"), css.indexOf("@media (max-width:520px)"));
  const header = html.slice(html.indexOf('<header class="map-header"'), html.indexOf("</header>"));

  // Same logo file, app name and Beta badge; no tagline or progress card.
  assert.match(header, /<img class="map-header-logo" src="\.\/ridge-trail-logo\.png" alt="Bay Area Ridge Trail" \/>/);
  assert.match(header, /Ridge Trail Passport/);
  assert.match(header, /class="beta-badge"/);
  assert.ok(!/progress|brand-intro/.test(header));

  // Hidden on desktop and on every tab but Map.
  assert.match(css, /^\.tab-bar,\.map-header\{display:none\}/m);
  assert.match(phone, /:not\(\[data-active-tab="map"\]\) :is\([^)]*\.map-header\)\{visibility:hidden\}/);

  // Slim, clears the notch, same see-through treatment as the tab bar, with
  // a solid strip behind the status-bar area.
  assert.match(phone, /--map-header-height:calc\(52px \+ env\(safe-area-inset-top\)\)/);
  const rule = phone.match(/\.map-header\{([^}]*)\}/)[1];
  assert.match(rule, /height:var\(--map-header-height\)/);
  assert.match(rule, /padding:env\(safe-area-inset-top\)/);
  assert.match(rule, /background:var\(--paper\);border-bottom:1px solid var\(--line\)/);
  assert.ok(!/box-shadow/.test(rule));
  assert.match(phone, /\.map-header\{background:rgba\(255,255,255,\.93\);-webkit-backdrop-filter:blur\(20px\);backdrop-filter:blur\(20px\)\}/);
  assert.match(phone, /\.map-header::before\{[^}]*position:fixed;top:0;[^}]*height:env\(safe-area-inset-top\);background:var\(--paper\)\}/);

  // The map area starts below the header, as it ends above the tab bar.
  assert.match(phone, /\.map-wrap\{position:absolute;top:var\(--map-header-height\);[^}]*bottom:var\(--tab-bar-height\)/);

  // Zoom framing measures the Map-tab header, never the hidden section list.
  const covered = ui.slice(ui.indexOf("function coveredMapEdges()"), ui.indexOf("// The search box only changes the list"));
  assert.match(covered, /const header = \$\("mapHeader"\);/);
  assert.match(covered, /headerShowing \? header\.getBoundingClientRect\(\) : null/);
  assert.ok(!/aside/.test(covered.replace(/\/\/.*$/gm, "")));
});

test("zoom framing with the phone header above the map: sheet below, nothing on top", () => {
  // 390x844 phone: header 0-52, map 52-732, tab bar 732-844, sheet 400-732.
  const map = box(0, 52, 390, 732);
  const sheet = box(0, 400, 390, 732);
  const header = box(0, 0, 390, 52);

  assert.deepEqual(coveredEdges(map, sheet, header), { top: 0, right: 0, bottom: 332, left: 0 });
  // If the header were ever moved over the map, it would be counted.
  assert.deepEqual(
    coveredEdges(box(0, 0, 390, 732), sheet, header),
    { top: 52, right: 0, bottom: 332, left: 0 }
  );
});

test("on phones Help covers the whole screen, header and tab bar included", async () => {
  const { readFile } = await import("node:fs/promises");
  const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
  const [help, mobile] = await Promise.all([read("../src/help.css"), read("../src/mobile-panel.css")]);
  const phoneHelp = help.slice(help.indexOf("@media (max-width:800px){"));
  const zIndex = (css, selector) => Number(css.match(new RegExp(`${selector}\\{[^}]*z-index:(\\d+)`))[1]);

  // Fixed to the screen rather than to the map area, which now stops short
  // of the header and the tab bar.
  assert.match(phoneHelp, /\.help-backdrop\{position:fixed;[^}]*env\(safe-area-inset-bottom\)/);
  assert.ok(zIndex(help, "\\.help-backdrop") > zIndex(mobile, "\\.tab-bar"));
  assert.ok(zIndex(help, "\\.help-backdrop") > zIndex(mobile, "\\.map-header"));
});

test("phone tab bar is an accessible tab list with arrow-key navigation", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/tab-bar.js", import.meta.url), "utf8");

  assert.match(source, /bar\.setAttribute\("role", "tablist"\)/);
  assert.match(source, /button\.setAttribute\("role", "tab"\)/);
  assert.match(source, /button\.setAttribute\("aria-selected", String\(active\)\)/);
  assert.match(source, /button\.tabIndex = active \? 0 : -1/);
  for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
    assert.ok(source.includes(`${key}:`), `missing ${key}`);
  }
  // The tabs do not use the old toggle's attributes.
  assert.ok(!/aria-expanded|aria-controls|aria-current/.test(source));
});
