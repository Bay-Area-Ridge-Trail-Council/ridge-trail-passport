export const CONFIG = {
  featureService:
    "https://services5.arcgis.com/6iLCtMhqIxD1wlgk/ArcGIS/rest/services/Bay_Area_Ridge_Trail_Official_Public_Route_Update/FeatureServer/0",

  // Keep this list limited to fields the app actually uses. Smaller responses
  // make startup faster and reduce the chance that unrelated schema changes
  // affect the Passport.
  featureFields: [
    "OBJECTID",
    "Segment_ID",
    "Section_Number",
    "Section_Name",
    "Trail_Type",
    "Calculated_Mileage",
    "Park_Managers",
    "Region",
    "County",
    "Segment_Name",
    "AllTrails_Link",
    "BRT_Website",
    "Partner_Website",
    "Dog_Permissions",
    "Bike_Permissions",
    "Horse_Permissions",
    "Restrooms",
    "Camping"
  ],

  // Decimal places ArcGIS keeps in each trail coordinate. The service sends
  // 12 by default, far more than a map can show; fewer digits make the
  // download smaller. 6 decimals is about 10 cm here — under half a pixel
  // even at the map's maximum zoom. 5 (about 1 m) was tested and made
  // curves visibly step-shaped at maximum zoom, so do not go lower than 6.
  geometryPrecision: 6,

  requestTimeoutMs: 15000,

  // The basemap is a MapLibre vector style. Changing tile provider means
  // changing styleUrl here and nowhere else. The style supplies its own
  // attribution (OpenFreeMap, OpenMapTiles, OpenStreetMap), which MapLibre
  // shows in the bottom-right corner of the map.
  basemap: {
    name: "OpenFreeMap Liberty",
    styleUrl: "https://tiles.openfreemap.org/styles/liberty",
    // MapLibre zoom levels are one lower than Leaflet's for the same scale,
    // so 18 here matches the old Leaflet limit of 19.
    maxZoom: 18
  },

  // MapLibre expects [longitude, latitude] — the opposite of Leaflet.
  // Zoom 8 in MapLibre shows the same area as zoom 9 did in Leaflet.
  initialMap: {
    center: [-122.15, 37.8],
    zoom: 8
  },

  colors: {
    route: "#D44526",
    complete: "#2e6f4f",
    selected: "#ffffff"
  },

  storageKey: "ridgeTrailPassportProgress"
};
