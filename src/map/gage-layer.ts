import type { Map as MapLibreMap } from 'maplibre-gl';
import type { CorridorPolygons, LngLat } from '../core/gage-geometry';
import { featuresToCrossings, type CrossingReport } from '../core/gage-crossing';
import { BUFFER_METERS, CORRIDORS } from '../core/gage-corridors';

/**
 * The ganjil-genap corridor layer.
 *
 * Two related jobs, one module: draw the corridors so the map shows what the constraint covers, and
 * answer "which of them does this route still run through" from the geometry MapLibre already has
 * loaded. The crossing answer deliberately comes from the *rendered* features rather than a second
 * copy of the geometry, so the map and the report can never disagree about where the corridors are.
 *
 * Colour rule (from the design): terracotta while the constraint is active *and* the request is
 * excluding the corridors; grey whenever it is not, so the layer states at a glance whether the
 * route on screen was asked to avoid these streets.
 */

/**
 * The generated corridors and their buffer, re-exported so a caller holding the map layer also has
 * the geometry behind it. The data itself lives in `src/core/gage-corridors.ts`, which does not
 * import MapLibre.
 */
export { BUFFER_METERS, CORRIDORS };

const SOURCE = 'gage';
const OUTLINE = 'gage-outline';
const LINE = 'gage-line';
const ROUTE_SOURCE = 'route';
const ROUTE_LINE = 'route-line';

/** Terracotta, the design token `--color-nb-terracotta`; the route line is the same colour. */
const ACTIVE_COLOR = '#c8553d';
/** Muted grey-brown, `--color-nb-black` at low opacity, for a constraint that is not being avoided. */
const INACTIVE_COLOR = '#6b6b6b';

/** One FeatureCollection with every ring, so MapLibre can filter and query it as one source. */
function corridorFeatures() {
  return {
    type: 'FeatureCollection' as const,
    features: CORRIDORS.flatMap(corridor => corridor.rings.map(ring => ({
      type: 'Feature' as const,
      id: corridor.id,
      properties: {
        id: corridor.id,
        name: corridor.name,
        bufferMeters: corridor.bufferMeters,
        perimeterMeters: ring.perimeterMeters,
      },
      geometry: { type: 'Polygon' as const, coordinates: [ring.coordinates] },
    }))),
  };
}

/** One FeatureCollection with the centre-lines, drawn on top so the street itself stays readable. */
function centerlineFeatures() {
  return {
    type: 'FeatureCollection' as const,
    features: CORRIDORS.map(corridor => ({
      type: 'Feature' as const,
      id: corridor.id,
      properties: { id: corridor.id, name: corridor.name },
      geometry: { type: 'LineString' as const, coordinates: corridor.centerline },
    })),
  };
}

/**
 * Draw the corridors, replacing whatever was drawn before.
 *
 * @param map - Loaded MapLibre map.
 * @param active - True while the constraint is active and the request excludes the corridors.
 * @returns The number of ring features drawn, or zero when the style was not loaded yet.
 * @remarks Callable before the map has a style, in which case it does nothing and returns zero:
 * `App` draws it again once `MapView` reports the style has loaded.
 */
export function drawGageLayer(map: MapLibreMap, active: boolean): number {
  // The source is only ever added to a loaded style; recolouring an existing layer is safe either
  // way, so this does not lock the layer out of an update that arrives during a style reload.
  if (!map.getSource(SOURCE) && !map.isStyleLoaded()) return 0;
  const color = active ? ACTIVE_COLOR : INACTIVE_COLOR;
  const data = corridorFeatures();
  const existing = map.getSource(SOURCE) as { setData(data: unknown): void } | undefined;
  if (!existing) {
    map.addSource(SOURCE, { type: 'geojson', data });
    map.addLayer({
      id: OUTLINE,
      type: 'fill',
      source: SOURCE,
      paint: { 'fill-color': color, 'fill-opacity': 0.28 },
    });
  } else {
    existing.setData(data);
  }
  if (!map.getSource(`${SOURCE}-lines`)) {
    map.addSource(`${SOURCE}-lines`, { type: 'geojson', data: centerlineFeatures() });
    map.addLayer({
      id: LINE,
      type: 'line',
      source: `${SOURCE}-lines`,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': color, 'line-width': 1.5, 'line-opacity': 0.9 },
    });
  }
  if (map.getLayer(OUTLINE)) map.setPaintProperty(OUTLINE, 'fill-color', color);
  if (map.getLayer(LINE)) map.setPaintProperty(LINE, 'line-color', color);
  return data.features.length;
}

/** Remove the corridor layers and sources, if any exist. */
export function clearGageLayer(map: MapLibreMap): void {
  if (map.getLayer(LINE)) map.removeLayer(LINE);
  if (map.getLayer(OUTLINE)) map.removeLayer(OUTLINE);
  if (map.getSource(`${SOURCE}-lines`)) map.removeSource(`${SOURCE}-lines`);
  if (map.getSource(SOURCE)) map.removeSource(SOURCE);
}

/**
 * Ask MapLibre which corridor rings the drawn route line touches.
 *
 * @param map - Loaded MapLibre map with both the route and the corridor layers drawn.
 * @returns The corridors the route still runs through, or an empty report when either layer is
 *   missing (nothing drawn has not been shown to cross anything).
 * @remarks `queryRenderedFeatures` tests the route's rendered segments against the corridor tiles,
 * so a route crossing a 35 m buffer is caught without re-implementing the geometry here; the pure
 * equivalent for tests and for callers without a map is `findCorridorCrossings`.
 */
export function crossingReportFromMap(map: MapLibreMap): CrossingReport {
  if (!map.getLayer(ROUTE_LINE) || !map.getLayer(OUTLINE)) return { corridors: [], count: 0 };
  const hits = map.queryRenderedFeatures({ layers: [ROUTE_LINE, OUTLINE] })
    .filter(feature => feature.layer.id === OUTLINE)
    .map(feature => feature.properties ?? {});
  return featuresToCrossings(hits);
}

/**
 * The corridors the map currently has selected for exclusion, as `[lng, lat]` rings.
 *
 * The request builder needs the same rings the layer draws; keeping them here means a route request
 * and a screenshot of the map can never be built from different geometry.
 *
 * @param selected - Corridor ids chosen for this request.
 * @returns One ring per chunk of each selected corridor.
 */
export function ringsFor(selected: CorridorPolygons[]): LngLat[][][] {
  return selected.map(corridor => corridor.rings.map(ring => ring.coordinates));
}
