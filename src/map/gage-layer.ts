import type { Map as MapLibreMap } from 'maplibre-gl';
import { CORRIDORS } from '../core/gage-corridors';

/**
 * The ganjil-genap corridor layer: draw the corridors so the map shows what the constraint covers.
 *
 * Drawing is all this module does. The crossing report — "which of them does this route still run
 * through" — is *not* a rendered-feature query: `src/state/scenario.ts` computes it with
 * `findCorridorCrossings` over the same generated rings the map draws and the request was packed
 * from (`src/core/gage-crossing.ts`), so the report never depends on which tiles happen to be on
 * screen. An earlier draft queried MapLibre for the answer; it was deleted because
 * `queryRenderedFeatures` without a geometry returns everything in the viewport, which is exactly
 * the false "no crossings" reading this feature exists to prevent.
 *
 * Colour rule (from the design): terracotta while the constraint is active *and* the request is
 * excluding the corridors; grey whenever it is not, so the layer states at a glance whether the
 * route on screen was asked to avoid these streets.
 */

const SOURCE = 'gage';
const OUTLINE = 'gage-outline';
const LINE = 'gage-line';

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
 * `App` draws it again once `MapView` reports the style has loaded. The geometry comes from
 * `src/core/gage-corridors.ts` — the same artifact `findCorridorCrossings` and the request packer
 * read — so the drawing can never disagree with the report about where the corridors are.
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
