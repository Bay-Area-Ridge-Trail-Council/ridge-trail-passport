import {
  LngLatBounds,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  setWorkerUrl
} from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";

import { CONFIG } from "./config.js";
import {
  getFeatureEndpoints,
  isCompletionEligible
} from "./trails.js";

// MapLibre does its tile work in a background worker. Vite bundles that
// worker as its own file; this tells MapLibre where to find it.
setWorkerUrl(maplibreWorkerUrl);

// Coordinates: MapLibre and GeoJSON both use [longitude, latitude].
// Zoom levels: MapLibre's are one lower than Leaflet's for the same scale.
// The zoom numbers below are the old Leaflet values minus one.
const FIT_MAX_ZOOM = 12;
const LOCATE_ZOOM = 11;

// How far (in screen pixels) from a trail line a click or tap still counts
// as hitting it. On touch screens this replaces the old invisible 18px-wide
// copy of every line.
const TOUCH_TOLERANCE_PX = 9;
const MOUSE_TOLERANCE_PX = 3;

// Trail tiling (see addAppLayers). Chosen for long trail lines viewed mostly
// at regional zooms; explained in the pull request that introduced them.
const TRAIL_TILE_MAXZOOM = 14;
const TRAIL_SIMPLIFY_TOLERANCE_PX = 1;

// Shown instead of the basemap if its style cannot be loaded (for example
// offline), so the trail still draws. Matches Leaflet's grey background.
const FALLBACK_STYLE = {
  version: 8,
  sources: {},
  layers: [
    {
      id: "fallback-background",
      type: "background",
      paint: { "background-color": "#dddddd" }
    }
  ]
};

const TRAIL_SOURCE = "ridge-trail";
const LOCATION_SOURCE = "my-location";
const MAIN_TRAIL_LAYER = "ridge-trail-main";
const SIDE_TRAIL_LAYER = "ridge-trail-side";
const TRAIL_LAYERS = [MAIN_TRAIL_LAYER, SIDE_TRAIL_LAYER];

const emptyCollection = () => ({ type: "FeatureCollection", features: [] });

// Data-driven style helpers: "selected" and "done" are set per feature with
// setFeatureState, so changing them never re-sends the trail geometry.
const isSelected = ["boolean", ["feature-state", "selected"], false];
const isDoneState = ["boolean", ["feature-state", "done"], false];

export function createRidgeMap({ onSelect, onBlankMapClick, isDone }) {
  const prefersReducedMotion =
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || false;

  const mobileViewportQuery = window.matchMedia?.("(max-width: 800px)");
  const isMobileViewport = () => Boolean(mobileViewportQuery?.matches);

  const useLargeTouchTargets =
    window.matchMedia?.("(pointer: coarse)").matches ||
    navigator.maxTouchPoints > 0;

  let map;

  try {
    map = new MapLibreMap({
      container: "map",
      style: CONFIG.basemap.styleUrl,
      center: CONFIG.initialMap.center,
      zoom: CONFIG.initialMap.zoom,
      maxZoom: CONFIG.basemap.maxZoom,
      // Always show the full attribution text (never collapse it to an icon).
      attributionControl: { compact: false },
      // Screen readers announce the map with the same name as before.
      locale: { "Map.Title": "Interactive Ridge Trail map" },
      // Leaflet had no rotation or tilt; keep the map flat and north-up.
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false
    });
  } catch (error) {
    // MapLibre needs WebGL 2, which some older or locked-down browsers lack.
    // Without this, the whole app (section list, progress) would fail to
    // start. Show a message in place of the map and keep everything else.
    console.warn("Could not start the map", error);
    return createUnavailableMap();
  }

  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.addControl(new NavigationControl({ showCompass: false }), "top-left");

  // --- Keeping the map sized to its container -----------------------------

  function refreshMapSize() {
    window.requestAnimationFrame(() => map.resize());
  }

  window.addEventListener(
    "load",
    () => {
      refreshMapSize();
      window.setTimeout(refreshMapSize, 200);
    },
    { once: true }
  );

  window.visualViewport?.addEventListener("resize", refreshMapSize);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshMapSize();
  });

  // --- Basemap fallback ---------------------------------------------------

  let styleHasLoaded = false;
  let usingFallbackStyle = false;

  function useFallbackStyle(reason) {
    if (styleHasLoaded || usingFallbackStyle) return;

    usingFallbackStyle = true;
    console.warn("Basemap unavailable; showing trail without it.", reason);
    map.setStyle(FALLBACK_STYLE);
  }

  const styleTimeout = window.setTimeout(
    () => useFallbackStyle("timed out"),
    CONFIG.requestTimeoutMs
  );

  map.on("error", (event) => {
    if (!styleHasLoaded) {
      useFallbackStyle(event.error);
    }
  });

  // --- Current state --------------------------------------------------------

  let currentFeatures = [];
  let currentSelectedId = null;
  let sourceFeatures = null;
  let locationData = emptyCollection();

  let endpointMarkers = [];
  let endpointMarkerSize = null;
  let endpointFeatures = null;

  // --- Layers (set up once per style load) ----------------------------------

  // Runs on the first style load and again if the fallback style replaces
  // the basemap, because changing style removes the app's own layers.
  function addAppLayers() {
    map.addSource(TRAIL_SOURCE, {
      type: "geojson",
      data: emptyCollection(),
      promoteId: "OBJECTID",
      // MapLibre cuts the trail into tiles in its background worker. Tiles
      // are only built up to TRAIL_TILE_MAXZOOM; closer in, those tiles are
      // enlarged. Tiles at that zoom keep every point of the original line,
      // so the trail stays accurate at the map's maximum zoom.
      maxzoom: TRAIL_TILE_MAXZOOM,
      // At lower zooms, points closer together than this (in screen pixels)
      // are merged. Less than a pixel is not visible on a 3.5px-wide line.
      tolerance: TRAIL_SIMPLIFY_TOLERANCE_PX
    });

    map.addSource(LOCATION_SOURCE, {
      type: "geojson",
      data: locationData
    });

    // White halo drawn under the selected section.
    map.addLayer({
      id: "ridge-trail-selected-highlight",
      type: "line",
      source: TRAIL_SOURCE,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": CONFIG.colors.selected,
        "line-width": 12.5,
        "line-opacity": ["case", isSelected, 0.95, 0]
      }
    });

    // Side trails: dashed. MapLibre measures dashes in multiples of the line
    // width, so [10, 8] pixels at a 3.5px width becomes [10/3.5, 8/3.5].
    map.addLayer({
      id: SIDE_TRAIL_LAYER,
      type: "line",
      source: TRAIL_SOURCE,
      filter: ["!", ["get", "isCompletionEligible"]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": CONFIG.colors.route,
        "line-width": ["case", isSelected, 7, 3.5],
        "line-opacity": ["case", isSelected, 1, 0.88],
        "line-dasharray": [10 / 3.5, 8 / 3.5]
      }
    });

    // Main Ridge Trail: solid, green once completed.
    map.addLayer({
      id: MAIN_TRAIL_LAYER,
      type: "line",
      source: TRAIL_SOURCE,
      filter: ["get", "isCompletionEligible"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": [
          "case",
          isDoneState,
          CONFIG.colors.complete,
          CONFIG.colors.route
        ],
        "line-width": ["case", isSelected, 7, isDoneState, 4.5, 3.5],
        "line-opacity": ["case", isSelected, 1, 0.9]
      }
    });

    // "My location" dot: white with a dark ring. MapLibre draws the ring
    // outside the radius, so 5.5 + 3 matches Leaflet's radius-7 circle.
    map.addLayer({
      id: "my-location",
      type: "circle",
      source: LOCATION_SOURCE,
      paint: {
        "circle-radius": 5.5,
        "circle-color": "#ffffff",
        "circle-stroke-color": "#1d2421",
        "circle-stroke-width": 3
      }
    });

    sourceFeatures = null;
    applyRender();
  }

  map.on("style.load", () => {
    styleHasLoaded = true;
    window.clearTimeout(styleTimeout);
    addAppLayers();
  });

  // --- Rendering ------------------------------------------------------------

  function applyRender() {
    const source = map.getSource(TRAIL_SOURCE);
    if (!source) return;

    // Only re-send geometry when the set of visible sections has changed.
    // Selection and completion changes are handled by feature state below.
    if (!sameFeatures(sourceFeatures, currentFeatures)) {
      source.setData({
        type: "FeatureCollection",
        features: currentFeatures.map((feature) => ({
          ...feature,
          properties: {
            ...feature.properties,
            isCompletionEligible: isCompletionEligible(feature.properties)
          }
        }))
      });
      sourceFeatures = currentFeatures;
    }

    for (const feature of currentFeatures) {
      const properties = feature.properties;

      map.setFeatureState(
        { source: TRAIL_SOURCE, id: properties.OBJECTID },
        {
          selected: properties.OBJECTID === currentSelectedId,
          done: isDone(properties)
        }
      );
    }
  }

  function render(features, selectedId) {
    currentFeatures = features;
    currentSelectedId = selectedId;

    applyRender();
    renderEndpoints();
  }

  // --- Endpoint markers -----------------------------------------------------

  function endpointDividerSize() {
    const zoom = map.getZoom();

    if (zoom < 9) return 0;
    if (zoom < 13) return 7;
    return 9;
  }

  function endpointElement(feature, size, selected) {
    const element = document.createElement("div");
    const inner = document.createElement("div");

    inner.className = `endpoint-marker${selected ? " selected" : ""}`;
    inner.style.width = `${size}px`;
    inner.style.height = `${size}px`;

    element.appendChild(inner);
    element.style.cursor = "pointer";
    // Decorative section dividers (as with Leaflet): not announced by
    // screen readers. Sections are reachable from the list instead.
    element.setAttribute("aria-hidden", "true");
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      onSelect(feature, { fit: false });
    });

    return element;
  }

  // Markers are only recreated when the visible sections or the marker size
  // change. Selecting a section just updates the existing markers' class.
  function renderEndpoints() {
    const size = endpointDividerSize();

    if (
      size === endpointMarkerSize &&
      sameFeatures(endpointFeatures, currentFeatures)
    ) {
      for (const { inner, objectId } of endpointMarkers) {
        inner.classList.toggle("selected", objectId === currentSelectedId);
      }
      return;
    }

    for (const { marker } of endpointMarkers) marker.remove();
    endpointMarkers = [];
    endpointMarkerSize = size;
    endpointFeatures = currentFeatures;

    if (size === 0) return;

    for (const feature of currentFeatures) {
      if (!isCompletionEligible(feature.properties)) continue;

      const endpoints = getFeatureEndpoints(feature);
      if (!endpoints) continue;

      const objectId = feature.properties.OBJECTID;
      const selected = objectId === currentSelectedId;

      // getFeatureEndpoints returns [latitude, longitude]; flip for MapLibre.
      for (const [lat, lng] of [endpoints.start, endpoints.end]) {
        const element = endpointElement(feature, size, selected);
        const marker = new Marker({ element })
          .setLngLat([lng, lat])
          .addTo(map);

        endpointMarkers.push({
          marker,
          inner: element.firstChild,
          objectId
        });
      }
    }
  }

  map.on("zoomend", renderEndpoints);

  // --- Clicking and tapping trail lines -------------------------------------

  function trailFeatureAt(point, tolerance) {
    if (!map.getLayer(MAIN_TRAIL_LAYER)) return null;

    const hits = map.queryRenderedFeatures(
      [
        [point.x - tolerance, point.y - tolerance],
        [point.x + tolerance, point.y + tolerance]
      ],
      { layers: TRAIL_LAYERS }
    );

    if (!hits.length) return null;

    // Hand back the original feature (full geometry), not MapLibre's
    // tiled copy of it.
    const objectId = hits[0].properties.OBJECTID;
    return (
      currentFeatures.find(
        (feature) => feature.properties.OBJECTID === objectId
      ) || null
    );
  }

  map.on("click", (event) => {
    if (event.originalEvent?.target?.closest?.(".maplibregl-marker")) return;

    const tolerance = useLargeTouchTargets
      ? TOUCH_TOLERANCE_PX
      : MOUSE_TOLERANCE_PX;
    const feature = trailFeatureAt(event.point, tolerance);

    if (feature) {
      onSelect(feature, { fit: false });
    } else if (isMobileViewport()) {
      onBlankMapClick?.();
    }
  });

  // Pointer cursor when hovering a trail line. MapLibre reports when the
  // pointer enters or leaves the trail layers, so this needs no hit-testing
  // of its own (and no click tolerance — the cursor only changes directly
  // over a line, while clicks still have the wider tolerance above).
  map.on("mouseenter", TRAIL_LAYERS, () => {
    map.getCanvas().style.cursor = "pointer";
  });

  map.on("mouseleave", TRAIL_LAYERS, () => {
    map.getCanvas().style.cursor = "";
  });

  // --- Camera -----------------------------------------------------------------

  function setLocation(lngLat) {
    locationData = lngLat
      ? {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: {},
              geometry: { type: "Point", coordinates: lngLat }
            }
          ]
        }
      : emptyCollection();

    map.getSource(LOCATION_SOURCE)?.setData(locationData);
  }

  function resetView() {
    setLocation(null);

    map.easeTo({
      center: CONFIG.initialMap.center,
      zoom: CONFIG.initialMap.zoom,
      animate: !prefersReducedMotion
    });
    refreshMapSize();
  }

  function fitToFeature(feature) {
    const bounds = featureBounds(feature);
    if (!bounds) return;

    map.fitBounds(bounds, {
      maxZoom: FIT_MAX_ZOOM,
      animate: !prefersReducedMotion
    });
  }

  function locate({ onError } = {}) {
    if (!navigator.geolocation) {
      onError?.("Location is not available in this browser.");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lngLat = [
          position.coords.longitude,
          position.coords.latitude
        ];

        setLocation(lngLat);

        map.easeTo({
          center: lngLat,
          zoom: LOCATE_ZOOM,
          animate: !prefersReducedMotion
        });
      },
      (error) => {
        const message =
          error.code === error.PERMISSION_DENIED
            ? "Location permission was not granted."
            : "Could not determine your location. Please try again.";

        onError?.(message);
      },
      {
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: 60000
      }
    );
  }

  return {
    render,
    resetView,
    fitToFeature,
    locate
  };
}

// Stand-in returned when the map cannot start. Same interface as the real
// map, so the rest of the app works unchanged.
function createUnavailableMap() {
  const message = document.createElement("div");
  message.className = "empty";
  message.textContent =
    "The map can't be shown in this browser. You can still browse sections and track progress from the list.";
  document.getElementById("map")?.replaceChildren(message);

  return {
    render() {},
    resetView() {},
    fitToFeature() {},
    locate({ onError } = {}) {
      onError?.("The map isn't available in this browser.");
    }
  };
}

// True when two feature lists contain the same feature objects in the same
// order (as happens when only selection or completion changed).
function sameFeatures(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;

  return a.every((feature, index) => feature === b[index]);
}

// The feature's bounding box, padded by 25% on each side like Leaflet's
// bounds.pad(0.25).
function featureBounds(feature) {
  const geometry = feature?.geometry;
  if (!geometry) return null;

  const lines =
    geometry.type === "LineString"
      ? [geometry.coordinates]
      : geometry.type === "MultiLineString"
        ? geometry.coordinates
        : [];

  const bounds = new LngLatBounds();

  for (const line of lines) {
    for (const coordinate of line || []) {
      if (Array.isArray(coordinate) && coordinate.length >= 2) {
        bounds.extend([coordinate[0], coordinate[1]]);
      }
    }
  }

  if (bounds.isEmpty()) return null;

  const west = bounds.getWest();
  const east = bounds.getEast();
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  const padLng = (east - west) * 0.25;
  const padLat = (north - south) * 0.25;

  return new LngLatBounds(
    [west - padLng, south - padLat],
    [east + padLng, north + padLat]
  );
}
