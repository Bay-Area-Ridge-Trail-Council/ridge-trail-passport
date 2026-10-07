import "./styles.css";
import "./detail-photo.css";
import "./desktop.css";
import "./mobile-panel.css";
import "./help.css";

import { fetchTrailFeatures, uniqueValues, validateSegmentIds } from "./data.js";
import { createRidgeMap } from "./map.js";
import {
  readCachedTrailFeatures,
  registerServiceWorker,
  sameTrailSnapshot,
  writeCachedTrailFeatures
} from "./offline.js";
import { createProgressStore, ProgressNotSavedError } from "./progress.js";
import { createUI } from "./ui.js";
import { acknowledgeBetaNotice, isBetaNoticeAcknowledged } from "./beta-notice.js";
import { CONFIG } from "./config.js";
import { isCompletionEligible } from "./trails.js";
import { $ } from "./utils.js";

let features = [];
let selectedObjectId = null;
let refreshInFlight = null;
let lastNetworkRefresh = 0;

const progressStore = createProgressStore();

let ridgeMap;
let ui;

function selectedFeature() {
  return (
    features.find(
      (feature) => feature.properties.OBJECTID === selectedObjectId
    ) || null
  );
}

function visibleFeatures() {
  return ui.filterFeatures(features);
}

function renderAll() {
  const visible = visibleFeatures();

  ridgeMap.render(visible, selectedObjectId);
  ui.renderProgress(features);
  ui.renderList(features, selectedObjectId);
  ui.renderDetails(selectedFeature());
}

function selectFeature(feature, { fit = false } = {}) {
  const alreadySelected = feature.properties.OBJECTID === selectedObjectId;
  selectedObjectId = feature.properties.OBJECTID;

  renderAll();
  ui.scrollSelectedIntoView(selectedObjectId);

  // Measured now that the detail panel is showing this section, so the map
  // can keep the section out from under it.
  const covered = ui.coveredMapEdges();

  if (fit) {
    ridgeMap.fitToFeature(feature, covered);
  } else if (!alreadySelected) {
    ridgeMap.panIntoView(feature, covered);
  }
}

function clearSelection() {
  if (selectedObjectId == null) return;

  selectedObjectId = null;
  renderAll();
}

function goHome() {
  selectedObjectId = null;
  renderAll();

  const app = $("app");
  const panelButton = $("mobilePanelToggle");
  app.classList.remove("mobile-panel-open");

  if (panelButton) {
    panelButton.setAttribute("aria-expanded", "false");
    panelButton.setAttribute("aria-label", "Expand section browser");
  }

  ridgeMap.resetView();
}

function toggleComplete(feature, { keepDetailsOpen = false } = {}) {
  const properties = feature.properties;

  if (!isCompletionEligible(properties)) {
    ui.showStatus(
      "Side trails do not count toward Ridge Trail completion."
    );
    return;
  }

  const wasComplete = progressStore.isDone(properties);
  let nowComplete;

  try {
    nowComplete = progressStore.toggle(properties);
  } catch (error) {
    if (!(error instanceof ProgressNotSavedError)) throw error;

    // Nothing changed in saved progress; redraw so the screen matches it.
    renderAll();
    ui.showStatus(
      wasComplete
        ? "Couldn't save — this section is still marked complete. Your browser may be blocking storage or out of space."
        : "Couldn't save — this section wasn't marked complete. Your browser may be blocking storage or out of space.",
      6000
    );
    return;
  }

  if (nowComplete == null) {
    ui.showStatus(
      "This section has a Segment ID data issue and cannot be saved yet.",
      4500
    );
    return;
  }

  renderAll();

  if (keepDetailsOpen) {
    ui.scrollSelectedIntoView(selectedObjectId);
  } else {
    ui.showStatus(
      nowComplete
        ? "Section marked complete ✓"
        : "Completion removed."
    );
  }
}

function handleFiltersChange() {
  const visibleObjectIds = new Set(
    visibleFeatures().map((feature) => feature.properties.OBJECTID)
  );

  if (
    selectedObjectId != null &&
    !visibleObjectIds.has(selectedObjectId)
  ) {
    selectedObjectId = null;
  }

  renderAll();
}

function resetProgress() {
  if (
    !window.confirm(
      "Clear all completed sections saved in this browser?"
    )
  ) {
    return;
  }

  progressStore.reset();
  selectedObjectId = null;
  renderAll();
  ui.showStatus("Progress reset.");
}

function initializeMobilePanelToggle() {
  const app = $("app");
  const button = $("mobilePanelToggle");

  if (!button) return;

  button.addEventListener("click", () => {
    const expanded = app.classList.toggle("mobile-panel-open");
    button.setAttribute("aria-expanded", String(expanded));
    button.setAttribute(
      "aria-label",
      expanded ? "Collapse section browser" : "Expand section browser"
    );
  });
}

function initializeHelpPanel() {
  const button = $("helpBtn");
  const backdrop = $("helpBackdrop");
  const panel = $("helpPanel");
  const closeButton = $("closeHelp");

  if (!button || !backdrop || !panel || !closeButton) return;

  function openHelp() {
    backdrop.hidden = false;
    closeButton.focus();
  }

  function closeHelp() {
    if (backdrop.hidden) return;
    backdrop.hidden = true;
    button.focus();
  }

  button.addEventListener("click", openHelp);
  closeButton.addEventListener("click", closeHelp);

  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) closeHelp();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !backdrop.hidden) {
      event.preventDefault();
      closeHelp();
    }
  });
}

// First-run beta notice. Same dialog pattern as the Help panel, but it can't
// be dismissed with Escape or a backdrop click: ticking the box and tapping
// Start is the only way through. While it is open, the rest of the app is
// made inert so keyboard and screen-reader users stay inside the notice.
function initializeBetaNotice() {
  const root = document.documentElement;
  const app = $("app");
  const backdrop = $("betaNoticeBackdrop");
  const panel = $("betaNoticePanel");
  const agree = $("betaNoticeAgree");
  const start = $("betaNoticeStart");

  if (!backdrop || !panel || !agree || !start || isBetaNoticeAcknowledged()) {
    root.classList.remove("beta-notice-pending");
    return;
  }

  backdrop.hidden = false;
  root.classList.remove("beta-notice-pending");
  app.inert = true;
  start.disabled = !agree.checked;

  agree.addEventListener("change", () => {
    start.disabled = !agree.checked;
  });

  start.addEventListener("click", () => {
    if (!agree.checked) return;

    // If storage is unavailable this returns false; the notice will simply
    // appear again on the next visit.
    acknowledgeBetaNotice();

    backdrop.hidden = true;
    app.inert = false;
  });

  // Focus the dialog itself rather than the checkbox: screen readers announce
  // the notice, the first Tab reaches the checkbox, and no focus ring shows
  // before anyone has used the keyboard.
  panel.focus();
}

// Feedback buttons only link to the form. Nothing is sent unless the visitor
// taps one and fills the form in themselves.
function initializeFeedbackLinks() {
  for (const id of ["feedbackBtn", "feedbackListLink"]) {
    const link = $(id);
    if (link) link.href = CONFIG.feedbackFormUrl;
  }
}

function initializeCompanionLinks() {
  const allTrailsLink = $("allTrailsCompanionLink");
  const farOutLink = $("farOutCompanionLink");

  if (!allTrailsLink || !farOutLink) return;

  const userAgent = navigator.userAgent || "";
  const isIOS =
    /iPad|iPhone|iPod/i.test(userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(userAgent);

  if (isIOS) {
    allTrailsLink.href =
      "https://apps.apple.com/us/app/alltrails-hike-bike-run/id405075943";
    farOutLink.href =
      "https://apps.apple.com/us/app/farout-hike-bike-paddle/id605447532";
  } else if (isAndroid) {
    allTrailsLink.href =
      "https://play.google.com/store/apps/details?id=com.alltrails.alltrails";
    farOutLink.href =
      "https://play.google.com/store/apps/details?id=com.atlasguides.guthook";
  }
}

function initializeProgressBackup() {
  const exportButton = $("exportProgressBtn");
  const importButton = $("importProgressBtn");
  const fileInput = $("progressFileInput");
  const feedback = $("progressBackupStatus");
  let feedbackTimer = null;

  if (!exportButton || !importButton || !fileInput || !feedback) return;

  function hideBackupFeedback() {
    if (feedbackTimer) {
      window.clearTimeout(feedbackTimer);
      feedbackTimer = null;
    }

    feedback.hidden = true;
    feedback.textContent = "";
    feedback.classList.remove("is-error");
  }

  function showBackupFeedback(message, { isError = false } = {}) {
    if (feedbackTimer) window.clearTimeout(feedbackTimer);

    feedback.textContent = message;
    feedback.classList.toggle("is-error", isError);
    feedback.hidden = false;

    feedbackTimer = window.setTimeout(() => {
      hideBackupFeedback();
    }, 7000);
  }

  exportButton.addEventListener("click", () => {
    const backup = progressStore.exportData();

    if (backup.completed.length === 0) {
      showBackupFeedback("No completed sections to export yet.", {
        isError: true
      });
      return;
    }

    const blob = new Blob(
      [JSON.stringify(backup, null, 2)],
      { type: "application/json" }
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const date = new Date().toISOString().slice(0, 10);

    link.href = url;
    link.download = `ridge-trail-passport-progress-${date}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);

    showBackupFeedback(
      `✓ Exported ${backup.completed.length} completed section${
        backup.completed.length === 1 ? "" : "s"
      }.`
    );
  });

  importButton.addEventListener("click", () => {
    hideBackupFeedback();
    fileInput.value = "";
    fileInput.click();
  });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    if (file.size > 1024 * 1024) {
      showBackupFeedback("That progress backup file is too large.", {
        isError: true
      });
      fileInput.value = "";
      return;
    }

    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const result = progressStore.importData(data);

      if (!result.saved) {
        throw new Error(
          "Couldn't save — nothing was imported. Your browser may be blocking storage or out of space."
        );
      }

      renderAll();

      const parts = [
        result.added === 0
          ? "No new completions imported."
          : `Imported ${result.added} new completed section${result.added === 1 ? "" : "s"}.`
      ];

      if (result.existing > 0) {
        parts.push(`${result.existing} already complete.`);
      }

      if (result.skipped > 0) {
        parts.push(`${result.skipped} invalid entr${result.skipped === 1 ? "y" : "ies"} skipped.`);
      }

      showBackupFeedback(`✓ ${parts.join(" ")}`);
    } catch (error) {
      console.warn("Could not import Ridge Trail progress backup", error);
      showBackupFeedback(
        error instanceof SyntaxError
          ? "That file is not a valid Ridge Trail Passport progress backup."
          : error?.message || "Could not import that progress backup.",
        { isError: true }
      );
    } finally {
      fileInput.value = "";
    }
  });
}

function applyTrailFeatures(nextFeatures, { showQaWarning = false } = {}) {
  const previousCounty = $("county").value;
  const previousRegion = $("region").value;

  features = nextFeatures;

  if (
    selectedObjectId != null &&
    !features.some(
      (feature) => feature?.properties?.OBJECTID === selectedObjectId
    )
  ) {
    selectedObjectId = null;
  }

  const segmentIdQa = validateSegmentIds(features);
  progressStore.setInvalidSegmentIds(segmentIdQa.duplicateSegmentIds);

  if (!segmentIdQa.valid) {
    console.warn("Segment_ID QA warning", segmentIdQa);

    if (showQaWarning) {
      const issues = [];

      if (segmentIdQa.missingObjectIds.length) {
        issues.push(
          `${segmentIdQa.missingObjectIds.length} missing Segment ID${
            segmentIdQa.missingObjectIds.length === 1 ? "" : "s"
          }`
        );
      }

      if (segmentIdQa.duplicateSegmentIds.length) {
        issues.push(
          `${segmentIdQa.duplicateSegmentIds.length} duplicate Segment ID${
            segmentIdQa.duplicateSegmentIds.length === 1 ? "" : "s"
          }`
        );
      }

      ui.showStatus(
        `Segment ID warning: ${issues.join(", ")}.`,
        6000
      );
    }
  }

  const counties = uniqueValues(features, "County");
  const regions = uniqueValues(features, "Region");

  ui.populateSelect("county", counties);
  ui.populateSelect("region", regions);

  if (counties.includes(previousCounty)) $("county").value = previousCounty;
  if (regions.includes(previousRegion)) $("region").value = previousRegion;

  renderAll();
}

async function refreshTrailData({
  showLoadError = false,
  showQaWarning = false
} = {}) {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const freshFeatures = await fetchTrailFeatures();
      lastNetworkRefresh = Date.now();

      await writeCachedTrailFeatures(freshFeatures);

      if (!sameTrailSnapshot(features, freshFeatures)) {
        applyTrailFeatures(freshFeatures, { showQaWarning });
      }
    } catch (error) {
      console.warn("Could not refresh Ridge Trail data", error);

      if (showLoadError && features.length === 0) {
        const message =
          error instanceof Error ? error.message : "Please try again.";

        ui.renderLoadError(message);
        ui.showStatus("Could not load Ridge Trail data.", 5000);
      }
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

function initializeBackgroundRefresh() {
  window.addEventListener("online", () => {
    refreshTrailData({ showLoadError: features.length === 0 });
  });

  document.addEventListener("visibilitychange", () => {
    const fiveMinutes = 5 * 60 * 1000;

    if (
      document.visibilityState === "visible" &&
      Date.now() - lastNetworkRefresh > fiveMinutes
    ) {
      refreshTrailData({ showLoadError: features.length === 0 });
    }
  });
}

async function initialize() {
  initializeBetaNotice();
  initializeFeedbackLinks();
  initializeMobilePanelToggle();
  initializeHelpPanel();
  initializeCompanionLinks();

  ui = createUI({
    progressStore,
    onSelect: selectFeature,
    onToggleComplete: toggleComplete,
    onFiltersChange: handleFiltersChange,
    onSearchInput: () => ui.renderList(features, selectedObjectId),
    onCloseDetails: clearSelection,
    onHome: goHome,
    onReset: resetProgress,
    onLocate: () =>
      ridgeMap.locate({
        onError: (message) => ui.showStatus(message)
      })
  });

  ridgeMap = createRidgeMap({
    onSelect: selectFeature,
    onBlankMapClick: () => {
      if (selectedObjectId != null) clearSelection();
    },
    isDone: (properties) => progressStore.isDone(properties)
  });

  initializeProgressBackup();

  const cachedFeatures = await readCachedTrailFeatures();

  if (cachedFeatures?.length) {
    applyTrailFeatures(cachedFeatures);
  }

  await refreshTrailData({
    showLoadError: true,
    showQaWarning: true
  });

  initializeBackgroundRefresh();
}

registerServiceWorker();
initialize();
