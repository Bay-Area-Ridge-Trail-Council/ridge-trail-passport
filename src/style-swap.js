// Moving the app's own map layers (trail lines, "my location" dot) from one
// map style to another. Plain object work with no map access, so it can be
// tested. map.js hands this to MapLibre when the basemap replaces the plain
// starting map; without it, changing style would remove the trail.

// Given the style the map is showing now and the style about to replace it,
// returns the new style with the app's sources and their layers added on
// top of it, in their current order. appSourceIds names the app's sources;
// every layer drawn from one of them comes along.
//
// Safe to run more than once: layers or sources the new style already has
// under the same name are replaced, never duplicated.
export function carryOverAppLayers(previousStyle, nextStyle, appSourceIds) {
  if (!previousStyle) return nextStyle;

  const sources = { ...nextStyle.sources };
  for (const id of appSourceIds) {
    if (previousStyle.sources?.[id]) sources[id] = previousStyle.sources[id];
  }

  const appLayers = (previousStyle.layers || []).filter((layer) =>
    appSourceIds.includes(layer.source)
  );
  const appLayerIds = new Set(appLayers.map((layer) => layer.id));
  const basemapLayers = (nextStyle.layers || []).filter(
    (layer) => !appLayerIds.has(layer.id)
  );

  return { ...nextStyle, sources, layers: [...basemapLayers, ...appLayers] };
}
