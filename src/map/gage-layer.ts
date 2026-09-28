import { Popup, type Map as MapLibreMap } from 'maplibre-gl';
import { ACTIVE_WINDOWS } from '../core/ganjil-genap';
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
 * Colour rule: red-terracotta while the constraint is active *and* the request is excluding the
 * corridors; yellow whenever it is not, so the layer states at a glance whether the route on screen
 * was asked to avoid these streets. (The first design used grey for the second state, which all but
 * vanished on the dark basemap.) Each corridor is drawn as a tinted, hatched buffer with a dashed
 * edge, a glowing centre-line and its street name, and as a dot below street zoom, so the area stays
 * findable from the national view.
 */

const SOURCE = 'gage';
const LINE_SOURCE = 'gage-lines';
const POINT_SOURCE = 'gage-points';
/** The tinted buffer fill; the id predates the hatch and is kept for the acceptance test's sake. */
const OUTLINE = 'gage-outline';
const HATCH = 'gage-hatch';
const EDGE = 'gage-edge';
const GLOW = 'gage-glow';
const LINE = 'gage-line';
const LABEL = 'gage-label';
const DOT = 'gage-dot';
/** Every layer this module owns, bottom to top. */
export const GAGE_LAYERS = [OUTLINE, HATCH, EDGE, GLOW, LINE, LABEL, DOT] as const;

/** Brighter than the `--color-nb-terracotta` token so a hatched corridor reads on the dark basemap. */
export const ACTIVE_COLOR = '#ff5a3c';
/** The `--color-nb-yellow` token: corridors that exist but are not being avoided. */
export const INACTIVE_COLOR = '#f2c14e';

const HATCH_ACTIVE = 'gage-hatch-active';
const HATCH_INACTIVE = 'gage-hatch-inactive';

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

/** The middle vertex of each centre-line, for the low-zoom dots. */
function centerFeatures() {
  return {
    type: 'FeatureCollection' as const,
    features: CORRIDORS.map(corridor => ({
      type: 'Feature' as const,
      properties: { id: corridor.id, name: corridor.name },
      geometry: { type: 'Point' as const, coordinates: corridor.centerline[Math.floor(corridor.centerline.length / 2)] },
    })),
  };
}

/** `[west, south, east, north]` around every corridor, for "zoom to the area". */
export function corridorBounds(): [number, number, number, number] {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const corridor of CORRIDORS) {
    for (const [lng, lat] of corridor.centerline) {
      west = Math.min(west, lng); east = Math.max(east, lng);
      south = Math.min(south, lat); north = Math.max(north, lat);
    }
  }
  return [west, south, east, north];
}

/** Diagonal stripes in `color`, as a MapLibre image. */
function hatchImage(color: string): { width: number; height: number; data: Uint8ClampedArray } | null {
  const size = 12;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.strokeStyle = color;
  context.lineWidth = 2.5;
  context.globalAlpha = 0.85;
  context.beginPath();
  // Three strokes so the stripe continues across tile edges without a seam.
  for (const offset of [-size, 0, size]) {
    context.moveTo(offset, size);
    context.lineTo(offset + size, 0);
  }
  context.stroke();
  return { width: size, height: size, data: context.getImageData(0, 0, size, size).data };
}

function ensureHatches(map: MapLibreMap): boolean {
  for (const [name, color] of [[HATCH_ACTIVE, ACTIVE_COLOR], [HATCH_INACTIVE, INACTIVE_COLOR]] as const) {
    if (map.hasImage(name)) continue;
    const image = hatchImage(color);
    if (!image) return false;
    map.addImage(name, image, { pixelRatio: 2 });
  }
  return true;
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
    map.addSource(LINE_SOURCE, { type: 'geojson', data: centerlineFeatures() });
    map.addSource(POINT_SOURCE, { type: 'geojson', data: centerFeatures() });
    map.addLayer({
      id: OUTLINE, type: 'fill', source: SOURCE,
      paint: { 'fill-color': color, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.35, 14, 0.22] },
    });
    if (ensureHatches(map)) {
      map.addLayer({
        id: HATCH, type: 'fill', source: SOURCE, minzoom: 11,
        paint: { 'fill-pattern': active ? HATCH_ACTIVE : HATCH_INACTIVE, 'fill-opacity': 0.9 },
      });
    }
    map.addLayer({
      id: EDGE, type: 'line', source: SOURCE,
      layout: { 'line-join': 'round' },
      paint: { 'line-color': color, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 15, 2.5], 'line-dasharray': [2, 1.5], 'line-opacity': 0.95 },
    });
    map.addLayer({
      id: GLOW, type: 'line', source: LINE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': color, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 4, 15, 16], 'line-blur': 5, 'line-opacity': 0.22 },
    });
    map.addLayer({
      id: LINE, type: 'line', source: LINE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': color, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.5, 15, 3.5], 'line-opacity': 0.95 },
    });
    map.addLayer({
      id: LABEL, type: 'symbol', source: LINE_SOURCE, minzoom: 12.5,
      layout: {
        'symbol-placement': 'line',
        'text-field': ['concat', 'GANJIL-GENAP · ', ['get', 'name']],
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 12.5, 10, 16, 13],
        'text-letter-spacing': 0.04,
        'symbol-spacing': 320,
        'text-optional': true,
      },
      paint: { 'text-color': '#111111', 'text-halo-color': color, 'text-halo-width': 2.2 },
    });
    map.addLayer({
      id: DOT, type: 'circle', source: POINT_SOURCE, maxzoom: 11.5,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3, 11, 7],
        'circle-color': color,
        'circle-stroke-color': '#111111',
        'circle-stroke-width': 2,
      },
    });
    installHover(map);
  } else {
    existing.setData(data);
  }
  for (const layer of [OUTLINE] as const) if (map.getLayer(layer)) map.setPaintProperty(layer, 'fill-color', color);
  for (const layer of [EDGE, GLOW, LINE] as const) if (map.getLayer(layer)) map.setPaintProperty(layer, 'line-color', color);
  if (map.getLayer(HATCH)) map.setPaintProperty(HATCH, 'fill-pattern', active ? HATCH_ACTIVE : HATCH_INACTIVE);
  if (map.getLayer(LABEL)) map.setPaintProperty(LABEL, 'text-halo-color', color);
  if (map.getLayer(DOT)) map.setPaintProperty(DOT, 'circle-color', color);
  return data.features.length;
}

/** Show or hide every corridor layer. */
export function setGageVisible(map: MapLibreMap, visible: boolean): void {
  for (const layer of GAGE_LAYERS) if (map.getLayer(layer)) map.setLayoutProperty(layer, 'visibility', visible ? 'visible' : 'none');
}

const WINDOWS_TEXT = ACTIVE_WINDOWS.map(window => `${String(window.startHour).padStart(2, '0')}:00–${String(window.endHour).padStart(2, '0')}:00`).join(' & ');

/** Name and rule on hover, so a corridor explains itself without the panel. */
function installHover(map: MapLibreMap): void {
  const popup = new Popup({ closeButton: false, closeOnClick: false, offset: 12, className: 'gage-popup' });
  const layers = [OUTLINE, LINE, DOT];
  const show = (event: { lngLat: { lng: number; lat: number }; features?: Array<{ properties?: Record<string, unknown> }> }) => {
    const name = event.features?.[0]?.properties?.name;
    if (typeof name !== 'string') return;
    map.getCanvas().style.cursor = 'help';
    popup.setLngLat(event.lngLat)
      .setHTML(`<strong>${name.replace(/[<>&]/g, '')}</strong><br>Ganjil-genap · Senin–Jumat ${WINDOWS_TEXT} WIB<br><span>Motor & skuter dikecualikan</span>`)
      .addTo(map);
  };
  const hide = () => {
    map.getCanvas().style.cursor = '';
    popup.remove();
  };
  for (const layer of layers) {
    map.on('mousemove', layer, show);
    map.on('mouseleave', layer, hide);
  }
}
