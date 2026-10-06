import L from "leaflet";

import { fetchFirstImageAttachment } from "./data.js";
import {
  isCompletionEligible,
  isRestricted,
  isSideTrail,
  milesFor,
  trailTypeLabel
} from "./trails.js";
import { $, debounce, escapeHtml, normalizeUrl } from "./utils.js";

const SEARCH_DEBOUNCE_MS = 200;

export function createUI({
  progressStore,
  onSelect,
  onToggleComplete,
  onFiltersChange,
  onSearchInput,
  onCloseDetails,
  onHome,
  onReset,
  onLocate
}) {
  let statusTimer = null;
  let detailPhotoRequestId = 0;
  let detailPhotoObjectId = null;

  const prefersReducedMotion =
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || false;

  function showStatus(message, milliseconds = 2400) {
    const element = $("status");
    const text = String(message ?? "").trim();

    window.clearTimeout(statusTimer);

    if (!text) {
      element.textContent = "";
      element.classList.remove("show");
      return;
    }

    element.textContent = text;
    element.classList.add("show");

    statusTimer = window.setTimeout(
      () => element.classList.remove("show"),
      milliseconds
    );
  }

  function getFilters() {
    return {
      search: $("search").value.trim().toLowerCase(),
      county: $("county").value,
      region: $("region").value,
      uncompletedOnly: $("unfinished").checked
    };
  }

  function filterFeatures(features) {
    const filters = getFilters();

    return features.filter((feature) => {
      const properties = feature.properties || {};
      const county = String(properties.County ?? "").trim();
      const region = String(properties.Region ?? "").trim();
      const searchText = [
        properties.Section_Name,
        properties.Segment_Name,
        properties.Park_Managers
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      const completionMatch =
        !filters.uncompletedOnly ||
        (isCompletionEligible(properties) &&
          !progressStore.isDone(properties));

      return (
        (!filters.search || searchText.includes(filters.search)) &&
        (!filters.county || county === filters.county) &&
        (!filters.region || region === filters.region) &&
        completionMatch
      );
    });
  }

  function populateSelect(id, values) {
    const select = $(id);

    while (select.options.length > 1) {
      select.remove(1);
    }

    for (const value of values) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    }
  }

  function renderProgress(features) {
    const stats = progressStore.stats(features);

    $("countText").textContent =
      `${stats.completedCount} / ${stats.totalCount}`;
    $("pctText").textContent = `${stats.percent}%`;
    $("progressBar").style.width = `${stats.percent}%`;
    $("progressTrack").setAttribute("aria-valuenow", String(stats.percent));
    $("mileText").textContent =
      `${stats.completedMiles.toFixed(1)} of ${stats.totalMiles.toFixed(1)} main-route miles completed`;
  }

  function sectionSortValue(properties) {
    const rawValue = properties.Section_Number;

    if (rawValue == null || String(rawValue).trim() === "") {
      return Number.POSITIVE_INFINITY;
    }

    const value = Number(rawValue);
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
  }

  function renderList(features, selectedId) {
    const list = $("list");

    const subset = filterFeatures(features)
      .filter((feature) =>
        isCompletionEligible(feature.properties)
      )
      .sort((a, b) => {
        const aProperties = a.properties || {};
        const bProperties = b.properties || {};

        return (
          sectionSortValue(aProperties) - sectionSortValue(bProperties) ||
          String(aProperties.Section_Name || "").localeCompare(
            String(bProperties.Section_Name || "")
          )
        );
      });

    list.replaceChildren();

    if (!subset.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No trail sections match these filters.";
      list.appendChild(empty);
      return;
    }

    for (const feature of subset) {
      const properties = feature.properties || {};
      const selected = selectedId === properties.OBJECTID;
      const done = progressStore.isDone(properties);
      const miles = milesFor(properties);
      const county = String(properties.County ?? "").trim();

      const card = document.createElement("div");
      card.className = `trail-card${selected ? " selected" : ""}`;
      card.dataset.objectid = String(properties.OBJECTID ?? "");

      const main = document.createElement("div");
      main.className = "trail-card-main";
      main.setAttribute("role", "button");
      main.setAttribute("tabindex", "0");

      const sectionLabel =
        properties.Section_Number != null
          ? `Section ${properties.Section_Number}`
          : "Ridge Trail section";

      const metadata = [
        county || null,
        miles ? `${miles.toFixed(1)} mi` : null
      ].filter(Boolean);

      main.innerHTML = `
        <div class="trail-number">${escapeHtml(sectionLabel)}</div>
        <div class="trail-title">${escapeHtml(
          properties.Section_Name || "Unnamed section"
        )}</div>
        <div class="trail-meta">
          ${metadata
            .map(
              (value, index) =>
                `${index ? '<span class="trail-meta-sep">•</span>' : ""}<span>${escapeHtml(value)}</span>`
            )
            .join("")}
        </div>
        ${
          isRestricted(properties)
            ? '<div class="restricted-list-badge">⚠ Restricted Access</div>'
            : ""
        }
      `;

      const select = () => onSelect(feature, { fit: true });

      main.onclick = select;
      main.onkeydown = (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          select();
        }
      };

      const side = document.createElement("div");
      side.className = "trail-card-side";

      const completeButton = document.createElement("button");
      completeButton.type = "button";
      completeButton.className =
        `complete-circle${done ? " done" : ""}`;
      completeButton.setAttribute("aria-pressed", String(done));
      completeButton.setAttribute(
        "aria-label",
        done ? "Mark section uncompleted" : "Mark section complete"
      );
      completeButton.title =
        done ? "Completed — click to undo" : "Mark complete";
      completeButton.textContent = done ? "✓" : "";
      completeButton.onclick = (event) => {
        event.stopPropagation();
        onToggleComplete(feature, { keepDetailsOpen: false });
      };

      const chevron = document.createElement("span");
      chevron.className = "chevron";
      chevron.textContent = "›";
      chevron.setAttribute("aria-hidden", "true");

      side.appendChild(completeButton);
      side.appendChild(chevron);
      card.appendChild(main);
      card.appendChild(side);
      list.appendChild(card);
    }
  }

  async function loadDetailPhoto(feature) {
    const photoContainer = $("detailPhoto");
    const properties = feature.properties || {};
    const objectId = String(properties.OBJECTID ?? "");

    if (detailPhotoObjectId === objectId) return;

    detailPhotoObjectId = objectId;
    const requestId = ++detailPhotoRequestId;

    photoContainer.hidden = true;
    photoContainer.replaceChildren();

    try {
      const photo = await fetchFirstImageAttachment(properties.OBJECTID);

      if (requestId !== detailPhotoRequestId || !photo) return;

      const image = document.createElement("img");
      image.src = photo.url;
      image.alt = `${properties.Section_Name || "Ridge Trail section"} photo`;
      image.loading = "lazy";
      image.decoding = "async";

      image.addEventListener(
        "error",
        () => {
          if (requestId !== detailPhotoRequestId) return;
          detailPhotoObjectId = null;
          photoContainer.hidden = true;
          photoContainer.replaceChildren();
        },
        { once: true }
      );

      photoContainer.appendChild(image);
      photoContainer.hidden = false;
    } catch (error) {
      if (requestId !== detailPhotoRequestId) return;
      detailPhotoObjectId = null;
      photoContainer.hidden = true;
      photoContainer.replaceChildren();
      console.warn("Could not load Ridge Trail attachment photo", error);
    }
  }

  function renderDetails(feature) {
    if (!feature) {
      detailPhotoRequestId += 1;
      detailPhotoObjectId = null;
      $("detailPhoto").hidden = true;
      $("detailPhoto").replaceChildren();
      $("sheet").classList.remove("open");
      $("mapHint").classList.remove("hide");
      return;
    }

    const properties = feature.properties || {};
    const miles = milesFor(properties);
    const county = String(properties.County ?? "").trim();
    const region = String(properties.Region ?? "").trim();

    $("mapHint").classList.add("hide");
    $("sheetEyebrow").textContent =
      [county, region].filter(Boolean).join(" • ") || "Trail section";

    $("sheetTitle").textContent =
      properties.Section_Name || "Ridge Trail section";

    $("sheetMeta").textContent = [
      properties.Section_Number != null
        ? `Section ${properties.Section_Number}`
        : null,
      miles ? `${miles.toFixed(1)} miles` : null,
      trailTypeLabel(properties)
    ]
      .filter(Boolean)
      .join(" • ");

    let notice = "";

    if (isRestricted(properties)) {
      notice =
        '<div class="access-warning"><b>⚠ Restricted Access</b><br>This is part of the main Ridge Trail and counts toward completion, but access restrictions apply. Check the linked Ridge Trail information before visiting.</div>';
    } else if (isSideTrail(properties)) {
      notice = `<div class="side-note"><b>${escapeHtml(
        trailTypeLabel(properties)
      )}</b><br>This is a side trail. It is shown for exploration and connectivity, but it does not count toward Ridge Trail completion.</div>`;
    }

    const bike = properties.Bike_Permissions || "Unknown";
    const horse = properties.Horse_Permissions || "Unknown";
    const dog = properties.Dog_Permissions || "Unknown";
    const restrooms = properties.Restrooms || "Unknown";
    const camping = properties.Camping || "Unknown";

    $("facts").innerHTML = `
      ${notice}

      <div class="detail-columns">
        <div class="detail-section">
          <div class="detail-label">Trail Access</div>
          <div class="detail-list">
            <div class="detail-row"><span class="detail-row-label">Hiking</span><span class="detail-row-value">Yes</span></div>
            <div class="detail-row"><span class="detail-row-label">Bikes</span><span class="detail-row-value">${escapeHtml(bike)}</span></div>
            <div class="detail-row"><span class="detail-row-label">Horses</span><span class="detail-row-value">${escapeHtml(horse)}</span></div>
            <div class="detail-row"><span class="detail-row-label">Dogs</span><span class="detail-row-value">${escapeHtml(dog)}</span></div>
          </div>
        </div>

        <div class="detail-section">
          <div class="detail-label">Amenities</div>
          <div class="detail-list">
            <div class="detail-row"><span class="detail-row-label">Restrooms</span><span class="detail-row-value">${escapeHtml(restrooms)}</span></div>
            <div class="detail-row"><span class="detail-row-label">Camping</span><span class="detail-row-value">${escapeHtml(camping)}</span></div>
          </div>
        </div>
      </div>

      ${
        properties.Park_Managers
          ? `
        <div class="detail-section">
          <div class="detail-label">Managed By</div>
          <div class="manager-line">${escapeHtml(
            properties.Park_Managers
          )}</div>
        </div>`
          : ""
      }
    `;

    const actions = $("sheetActions");
    actions.replaceChildren();

    const stack = document.createElement("div");
    stack.className = "detail-actions";

    if (isCompletionEligible(properties)) {
      const done = progressStore.isDone(properties);
      const completionButton = document.createElement("button");
      completionButton.type = "button";
      completionButton.className = "primary";
      completionButton.setAttribute("aria-pressed", String(done));
      completionButton.textContent = done
        ? "✓ Completed — undo"
        : "Mark this section complete";
      completionButton.onclick = () =>
        onToggleComplete(feature, { keepDetailsOpen: true });
      stack.appendChild(completionButton);
    }

    for (const [field, label] of [
      ["BRT_Website", "RidgeTrail.org ↗"],
      ["Partner_Website", "Partner Website ↗"],
      ["AllTrails_Link", "AllTrails ↗"]
    ]) {
      const href = normalizeUrl(properties[field]);
      if (!href) continue;

      const link = document.createElement("a");
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.className = "detail-link";
      link.textContent = label;
      stack.appendChild(link);
    }

    actions.appendChild(stack);
    $("sheet").classList.add("open");
    loadDetailPhoto(feature);
  }

  function renderLoadError(message) {
    const list = $("list");
    const empty = document.createElement("div");
    const heading = document.createElement("b");
    const detail = document.createElement("div");

    empty.className = "empty";
    heading.textContent = "Could not load the Ridge Trail feature service.";
    detail.className = "empty-detail";
    detail.textContent = String(message || "Please try again.");

    empty.appendChild(heading);
    empty.appendChild(detail);
    list.replaceChildren(empty);
  }

  function scrollSelectedIntoView(selectedId) {
    if (selectedId == null) return;

    window.requestAnimationFrame(() => {
      const selectedCard = document.querySelector(
        `.trail-card[data-objectid="${selectedId}"]`
      );

      selectedCard?.scrollIntoView({
        block: "nearest",
        behavior: prefersReducedMotion ? "auto" : "smooth"
      });
    });
  }

  // Rebuilding the map on every keystroke is slow on phones, so the search
  // box updates the list right away and waits for a pause in typing before
  // updating the map. The other filters still apply immediately.
  const searchFiltersChange = debounce(onFiltersChange, SEARCH_DEBOUNCE_MS);

  $("search").addEventListener("input", () => {
    onSearchInput();
    searchFiltersChange();
  });

  for (const id of ["county", "region", "unfinished"]) {
    $(id).addEventListener("change", () => {
      searchFiltersChange.cancel();
      onFiltersChange();
    });
  }

  $("closeSheet").onclick = onCloseDetails;
  $("homeBtn").onclick = onHome;
  $("resetBtn").onclick = onReset;
  $("locateBtn").onclick = onLocate;

  for (const id of ["list", "sheet"]) {
    const element = $(id);
    L.DomEvent.disableClickPropagation(element);
    L.DomEvent.disableScrollPropagation(element);
  }

  return {
    showStatus,
    filterFeatures,
    populateSelect,
    renderProgress,
    renderList,
    renderDetails,
    renderLoadError,
    scrollSelectedIntoView
  };
}
