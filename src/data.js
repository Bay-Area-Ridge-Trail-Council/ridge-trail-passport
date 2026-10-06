import { CONFIG } from "./config.js";

const attachmentCache = new Map();

function buildQueryUrl() {
  const params = new URLSearchParams({
    where: "1=1",
    outFields: CONFIG.featureFields.join(","),
    returnGeometry: "true",
    outSR: "4326",
    geometryPrecision: String(CONFIG.geometryPrecision),
    f: "geojson"
  });

  return `${CONFIG.featureService}/query?${params.toString()}`;
}

async function fetchJson(url, label) {
  const controller = new AbortController();
  const timer = window.setTimeout(
    () => controller.abort(),
    CONFIG.requestTimeoutMs
  );

  try {
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      throw new Error(`${label} returned HTTP ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${label} timed out. Please try again.`);
    }

    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

function arcGisErrorMessage(data, fallback) {
  if (!data?.error) return null;

  return data.error.message || fallback;
}

export async function fetchTrailFeatures() {
  const data = await fetchJson(buildQueryUrl(), "Feature service");
  const arcGisError = arcGisErrorMessage(
    data,
    "The feature service returned an ArcGIS error."
  );

  if (arcGisError) {
    throw new Error(arcGisError);
  }

  if (!Array.isArray(data.features)) {
    throw new Error(
      "The feature service did not return a GeoJSON feature collection."
    );
  }

  return data.features;
}

async function loadFirstImageAttachment(objectId) {
  const encodedObjectId = encodeURIComponent(objectId);
  const url = `${CONFIG.featureService}/${encodedObjectId}/attachments?f=json`;
  const data = await fetchJson(url, "Attachment service");
  const arcGisError = arcGisErrorMessage(
    data,
    "Could not load attachments."
  );

  if (arcGisError) {
    throw new Error(arcGisError);
  }

  const attachmentInfos = Array.isArray(data.attachmentInfos)
    ? data.attachmentInfos
    : [];

  const attachment = attachmentInfos.find((item) =>
    String(item.contentType || "")
      .toLowerCase()
      .startsWith("image/")
  );

  if (!attachment) return null;

  return {
    url: `${CONFIG.featureService}/${encodedObjectId}/attachments/${encodeURIComponent(
      attachment.id
    )}`,
    name: attachment.name || "Ridge Trail photo",
    contentType: attachment.contentType || ""
  };
}

// ArcGIS attachments are queried only when a detail card opens. Cache the
// metadata result so reopening the same section does not repeat the request.
export function fetchFirstImageAttachment(objectId) {
  if (objectId == null) return Promise.resolve(null);

  const key = String(objectId);

  if (!attachmentCache.has(key)) {
    const request = loadFirstImageAttachment(objectId).catch((error) => {
      attachmentCache.delete(key);
      throw error;
    });

    attachmentCache.set(key, request);
  }

  return attachmentCache.get(key);
}

export function validateSegmentIds(features) {
  const seen = new Map();
  const missingObjectIds = [];
  const duplicates = [];

  for (const feature of features) {
    const properties = feature?.properties || {};
    const segmentId = String(properties.Segment_ID || "").trim();

    if (!segmentId) {
      missingObjectIds.push(properties.OBJECTID);
      continue;
    }

    if (seen.has(segmentId)) {
      duplicates.push(segmentId);
    } else {
      seen.set(segmentId, properties.OBJECTID);
    }
  }

  return {
    missingObjectIds,
    duplicateSegmentIds: [...new Set(duplicates)],
    valid: missingObjectIds.length === 0 && duplicates.length === 0
  };
}

export function uniqueValues(features, field) {
  const values = features
    .map((feature) => feature?.properties?.[field])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);

  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}
