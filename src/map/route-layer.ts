import { Marker, type Map as MapLibreMap } from 'maplibre-gl';
import type { RouteResult } from 'valhalla-browser';
import type { LegFigures, WaypointTime } from '../core/leg-timeline';
import type { Waypoint } from '../core/request-builder';
import type { LegLabelMode } from '../state/view';
import { formatKilometers, formatShortDuration, formatSpeed } from '../ui/format';

const SOURCE = 'route';
const CASING = 'route-casing';
const LINE = 'route-line';
const ANIM_SOURCE = 'route-anim';
const ANIM_GLOW = 'route-anim-glow';
const ANIM_LINE = 'route-anim-line';
const HEAD_SOURCE = 'route-head';
const HEAD_HALO = 'route-head-halo';
const HEAD_DOT = 'route-head-dot';

/**
 * One colour per leg, chosen to read on the dark basemap and to stay clear of the ganjil-genap
 * colours (terracotta for corridors being avoided, yellow for corridors that are not): the first
 * six legs never reuse either, and a longer trip cycles.
 */
export const LEG_COLORS = ['#4fc3f7', '#7bd88f', '#ff6ec7', '#b39ddb', '#26d7c4', '#ff9f43', '#e6ee9c', '#90caf9'] as const;

/** Colour of leg `index`, cycling through {@link LEG_COLORS}. */
export function legColor(index: number): string {
  return LEG_COLORS[index % LEG_COLORS.length];
}

/** Live waypoint markers per map, so a redraw replaces them instead of stacking them. */
const markers = new WeakMap<MapLibreMap, Marker[]>();
/** Live leg-label markers per map. */
const legLabels = new WeakMap<MapLibreMap, Marker[]>();
/** The running animation's frame request per map, so a new route stops the old animation. */
const animations = new WeakMap<MapLibreMap, number>();

/**
 * Decode one Valhalla polyline6 shape into `[lng, lat]` pairs.
 * @param shape - The encoded `legs[].shape` string.
 * @returns GeoJSON-ready coordinates in degrees.
 */
export function decodePolyline6(shape: string): [number, number][] {
  const points: [number, number][] = [];
  let index = 0, lat = 0, lng = 0;
  while (index < shape.length) {
    for (const axis of [0, 1]) {
      let result = 0, shift = 0, byte = 0;
      do { byte = shape.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta; else lng += delta;
    }
    points.push([lng / 1e6, lat / 1e6]);
  }
  return points;
}

/** Every leg's geometry, concatenated in travel order. */
export function routeCoordinates(result: RouteResult): [number, number][] {
  return result.native.trip.legs.flatMap(leg => decodePolyline6(leg.shape));
}

/** Great-circle distance in metres; enough precision to share a maneuver's time along its edges. */
function haversineMeters([lng1, lat1]: [number, number], [lng2, lat2]: [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** One leg as drawn: its coordinates and the trip time (seconds from the first stop) at each. */
export interface TrackLeg {
  coordinates: [number, number][];
  /** Same length as `coordinates`, non-decreasing. */
  times: number[];
  /** Metres from the leg's first coordinate, same length as `coordinates`. */
  distances: number[];
}

export interface RouteTrack {
  legs: TrackLeg[];
  totalSeconds: number;
}

/**
 * The route as a timed track: where the vehicle is at every second of the trip.
 *
 * @param result - Native route result.
 * @returns Per-leg coordinates with a trip time on every vertex.
 * @remarks Each maneuver's native `time` is spread over the shape points it covers
 *   (`begin_shape_index`..`end_shape_index`) in proportion to distance, so the animation slows down
 *   where native says the road is slow instead of moving at one speed. A leg whose maneuvers carry
 *   no usable shape indexes spreads its whole time by distance instead.
 */
export function routeTrack(result: RouteResult): RouteTrack {
  let offset = 0;
  const legs = result.native.trip.legs.map(leg => {
    const coordinates = decodePolyline6(leg.shape);
    const segments = coordinates.slice(1).map((point, index) => haversineMeters(coordinates[index], point));
    const distances = [0];
    for (const segment of segments) distances.push(distances[distances.length - 1] + segment);
    const legTime = leg.maneuvers.reduce((sum, maneuver) => sum + maneuver.time, 0);
    const segmentTimes = new Array<number>(segments.length).fill(0);
    const indexed = leg.maneuvers.every(maneuver => {
      const begin = (maneuver as { begin_shape_index?: unknown }).begin_shape_index;
      const end = (maneuver as { end_shape_index?: unknown }).end_shape_index;
      return typeof begin === 'number' && typeof end === 'number' && begin >= 0 && end >= begin && end < coordinates.length;
    });
    const spread = (begin: number, end: number, time: number) => {
      const span = distances[end] - distances[begin];
      for (let index = begin; index < end; index++) segmentTimes[index] += span > 0 ? time * (segments[index] / span) : time / (end - begin);
    };
    if (indexed && segments.length > 0) {
      for (const maneuver of leg.maneuvers) {
        const begin = (maneuver as unknown as { begin_shape_index: number }).begin_shape_index;
        const end = (maneuver as unknown as { end_shape_index: number }).end_shape_index;
        if (end > begin) spread(begin, end, maneuver.time);
      }
    } else if (segments.length > 0) {
      spread(0, segments.length, legTime);
    }
    const times = [offset];
    for (const time of segmentTimes) times.push(times[times.length - 1] + time);
    offset = times[times.length - 1];
    return { coordinates, times, distances };
  });
  return { legs, totalSeconds: offset };
}

/** The point `fraction` of the way along a leg by distance, for its label. */
export function pointAlong(leg: TrackLeg, fraction: number): [number, number] | null {
  if (leg.coordinates.length === 0) return null;
  const target = leg.distances[leg.distances.length - 1] * fraction;
  let index = leg.distances.findIndex(distance => distance >= target);
  if (index <= 0) return leg.coordinates[Math.max(0, index)];
  const [before, after] = [leg.coordinates[index - 1], leg.coordinates[index]];
  const span = leg.distances[index] - leg.distances[index - 1];
  const t = span > 0 ? (target - leg.distances[index - 1]) / span : 0;
  return [before[0] + (after[0] - before[0]) * t, before[1] + (after[1] - before[1]) * t];
}

/**
 * The part of the track driven by trip time `seconds`, plus where the vehicle is.
 * @returns One partial coordinate list per leg (empty for legs not reached yet) and the head.
 */
export function trackAt(track: RouteTrack, seconds: number): { legs: [number, number][][]; head: [number, number] | null; leg: number } {
  let head: [number, number] | null = null;
  let current = 0;
  const legs = track.legs.map((leg, legIndex) => {
    const { coordinates, times } = leg;
    if (coordinates.length === 0 || times[0] > seconds) return [];
    current = legIndex;
    if (times[times.length - 1] <= seconds) {
      head = coordinates[coordinates.length - 1];
      return coordinates;
    }
    let low = 0, high = times.length - 1;
    while (low < high - 1) {
      const middle = (low + high) >> 1;
      if (times[middle] <= seconds) low = middle; else high = middle;
    }
    const span = times[high] - times[low];
    const t = span > 0 ? (seconds - times[low]) / span : 0;
    const point: [number, number] = [
      coordinates[low][0] + (coordinates[high][0] - coordinates[low][0]) * t,
      coordinates[low][1] + (coordinates[high][1] - coordinates[low][1]) * t,
    ];
    head = point;
    return [...coordinates.slice(0, low + 1), point];
  });
  return { legs, head, leg: current };
}

const emptyCollection = () => ({ type: 'FeatureCollection' as const, features: [] });

function legCollection(legs: [number, number][][]) {
  return {
    type: 'FeatureCollection' as const,
    features: legs.flatMap((coordinates, index) => (coordinates.length < 2 ? [] : [{
      type: 'Feature' as const,
      properties: { leg: index, color: legColor(index) },
      geometry: { type: 'LineString' as const, coordinates },
    }])),
  };
}

type GeoJsonSource = { setData(data: unknown): void };

function setSource(map: MapLibreMap, id: string, data: unknown): void {
  const existing = map.getSource(id) as GeoJsonSource | undefined;
  if (existing) existing.setData(data);
  else map.addSource(id, { type: 'geojson', data: data as never });
}

/**
 * Draw (or redraw) the route, one colour per leg, over a dark casing.
 * @param map - Loaded MapLibre map.
 * @param result - Native route result.
 * @returns The number of coordinates drawn; zero means the response carried no geometry.
 */
export function drawRoute(map: MapLibreMap, result: RouteResult): number {
  const track = routeTrack(result);
  setSource(map, SOURCE, legCollection(track.legs.map(leg => leg.coordinates)));
  setSource(map, ANIM_SOURCE, emptyCollection());
  setSource(map, HEAD_SOURCE, emptyCollection());
  const round = { 'line-cap': 'round', 'line-join': 'round' } as const;
  if (!map.getLayer(CASING)) {
    map.addLayer({ id: CASING, type: 'line', source: SOURCE, layout: round,
      paint: { 'line-color': '#111111', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 6, 14, 11], 'line-opacity': 0.85 } });
  }
  if (!map.getLayer(LINE)) {
    map.addLayer({ id: LINE, type: 'line', source: SOURCE, layout: round,
      paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 14, 6] } });
  }
  if (!map.getLayer(ANIM_GLOW)) {
    map.addLayer({ id: ANIM_GLOW, type: 'line', source: ANIM_SOURCE, layout: round,
      paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 10, 14, 18], 'line-blur': 6, 'line-opacity': 0.55 } });
  }
  if (!map.getLayer(ANIM_LINE)) {
    map.addLayer({ id: ANIM_LINE, type: 'line', source: ANIM_SOURCE, layout: round,
      paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3.5, 14, 7] } });
  }
  if (!map.getLayer(HEAD_HALO)) {
    map.addLayer({ id: HEAD_HALO, type: 'circle', source: HEAD_SOURCE,
      paint: { 'circle-radius': 16, 'circle-color': ['get', 'color'], 'circle-opacity': 0.35, 'circle-blur': 0.6 } });
  }
  if (!map.getLayer(HEAD_DOT)) {
    map.addLayer({ id: HEAD_DOT, type: 'circle', source: HEAD_SOURCE,
      paint: { 'circle-radius': 6, 'circle-color': '#f5efe6', 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 4 } });
  }
  setRouteOpacity(map, 1);
  return track.legs.reduce((sum, leg) => sum + leg.coordinates.length, 0);
}

/** Full route dimmed while the animation traces it, full strength otherwise. */
function setRouteOpacity(map: MapLibreMap, opacity: number): void {
  if (map.getLayer(LINE)) map.setPaintProperty(LINE, 'line-opacity', opacity);
  if (map.getLayer(CASING)) map.setPaintProperty(CASING, 'line-opacity', 0.85 * Math.max(opacity, 0.4));
}

export interface AnimationFrame {
  /** Trip seconds from the first stop that the vehicle has reached. */
  seconds: number;
  /** 0–1 share of the trip time. */
  progress: number;
  /** Leg the vehicle is on. */
  leg: number;
  done: boolean;
}

/**
 * Trace the route from the first stop to the last, timed by native's own travel times.
 *
 * @param map - Map the route was drawn on with {@link drawRoute}.
 * @param result - The same result.
 * @param onFrame - Called on every frame, for the on-map clock.
 * @returns A function that stops the animation and leaves the full route drawn.
 * @remarks The playback clock is linear in *trip* time, so the head moves slowly where the route is
 *   slow; wall-clock length scales with the trip and is capped so a long route still finishes.
 *   Honours `prefers-reduced-motion` by drawing the route at once.
 */
export function animateRoute(map: MapLibreMap, result: RouteResult, onFrame?: (frame: AnimationFrame) => void): () => void {
  stopAnimation(map);
  const track = routeTrack(result);
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced || track.totalSeconds <= 0 || !map.getSource(ANIM_SOURCE)) {
    onFrame?.({ seconds: track.totalSeconds, progress: 1, leg: Math.max(0, track.legs.length - 1), done: true });
    return () => {};
  }
  const durationMs = Math.min(9000, Math.max(3000, 3000 + (track.totalSeconds / 3600) * 2500));
  const started = performance.now();
  setRouteOpacity(map, 0.22);
  const finish = () => {
    animations.delete(map);
    (map.getSource(ANIM_SOURCE) as GeoJsonSource | undefined)?.setData(emptyCollection());
    (map.getSource(HEAD_SOURCE) as GeoJsonSource | undefined)?.setData(emptyCollection());
    setRouteOpacity(map, 1);
  };
  const frame = (now: number) => {
    const progress = Math.min(1, (now - started) / durationMs);
    const seconds = progress * track.totalSeconds;
    const at = trackAt(track, seconds);
    (map.getSource(ANIM_SOURCE) as GeoJsonSource | undefined)?.setData(legCollection(at.legs));
    (map.getSource(HEAD_SOURCE) as GeoJsonSource | undefined)?.setData(at.head
      ? { type: 'Feature', properties: { color: legColor(at.leg) }, geometry: { type: 'Point', coordinates: at.head } }
      : emptyCollection());
    onFrame?.({ seconds, progress, leg: at.leg, done: progress >= 1 });
    if (progress >= 1) {
      finish();
      return;
    }
    animations.set(map, requestAnimationFrame(frame));
  };
  animations.set(map, requestAnimationFrame(frame));
  return () => {
    if (!animations.has(map)) return;
    stopAnimation(map);
    finish();
  };
}

function stopAnimation(map: MapLibreMap): void {
  const handle = animations.get(map);
  if (handle !== undefined) cancelAnimationFrame(handle);
  animations.delete(map);
}

/** Remove every route layer and source, if they exist. */
export function clearRoutes(map: MapLibreMap): void {
  stopAnimation(map);
  for (const layer of [HEAD_DOT, HEAD_HALO, ANIM_LINE, ANIM_GLOW, LINE, CASING]) if (map.getLayer(layer)) map.removeLayer(layer);
  for (const source of [HEAD_SOURCE, ANIM_SOURCE, SOURCE]) if (map.getSource(source)) map.removeSource(source);
  clearLegLabels(map);
}

/** Label text for one leg in the chosen mode. */
export function legLabelText(leg: LegFigures, arrival: WaypointTime | undefined, mode: LegLabelMode): string {
  const eta = arrival ? `tiba ${arrival.clock}` : '';
  if (mode === 'speed') return `L${leg.index + 1} · ${formatSpeed(leg.speedKmh)}`;
  if (mode === 'eta') return [`L${leg.index + 1}`, formatShortDuration(leg.timeSeconds), eta].filter(Boolean).join(' · ');
  return [`L${leg.index + 1}`, formatKilometers(leg.lengthKm), formatShortDuration(leg.timeSeconds), formatSpeed(leg.speedKmh), eta].filter(Boolean).join(' · ');
}

/**
 * One label per leg, at the leg's midpoint by distance: speed, ETA or both.
 * @param times - Waypoint clocks; leg `i` arrives at waypoint `i + 1`.
 */
export function drawLegLabels(map: MapLibreMap, result: RouteResult, legs: LegFigures[], times: WaypointTime[], mode: LegLabelMode): void {
  clearLegLabels(map);
  if (mode === 'off') return;
  const track = routeTrack(result);
  const drawn = legs.flatMap(leg => {
    const trackLeg = track.legs[leg.index];
    const at = trackLeg ? pointAlong(trackLeg, 0.5) : null;
    if (!at) return [];
    const element = document.createElement('div');
    element.className = 'leg-label';
    element.dataset.leg = String(leg.index + 1);
    element.style.setProperty('--leg-color', legColor(leg.index));
    element.textContent = legLabelText(leg, times[leg.index + 1], mode);
    return [new Marker({ element, anchor: 'center' }).setLngLat(at).addTo(map)];
  });
  legLabels.set(map, drawn);
}

/** Remove every leg label this module added. */
export function clearLegLabels(map: MapLibreMap): void {
  for (const marker of legLabels.get(map) ?? []) marker.remove();
  legLabels.set(map, []);
}

export interface WaypointMarkerOptions {
  /** Clock time at each stop, when a route exists. */
  times?: WaypointTime[];
  /** Colour of the leg leaving each stop, when a route exists. */
  colored?: boolean;
  /** Called when a marker is dropped somewhere new. */
  onMove?: (index: number, point: { lng: number; lat: number }) => void;
  /** Called on right-click. */
  onRemove?: (index: number) => void;
}

/**
 * Draw one numbered, draggable marker per waypoint, replacing any markers already on the map.
 * @param map - Loaded MapLibre map.
 * @param waypoints - Stops in visit order; the marker number is the index plus one.
 * @param options - Clock times, leg colouring and the drag/remove callbacks.
 */
export function drawWaypoints(map: MapLibreMap, waypoints: Waypoint[], options: WaypointMarkerOptions = {}): void {
  clearWaypoints(map);
  const last = waypoints.length - 1;
  const drawn = waypoints.map((point, index) => {
    const element = document.createElement('div');
    element.className = 'wp-marker';
    element.dataset.waypoint = String(index + 1);
    element.title = `Titik ${index + 1} — seret untuk memindah, klik kanan untuk menghapus`;
    const badge = document.createElement('span');
    badge.className = 'wp-badge';
    badge.textContent = String(index + 1);
    if (options.colored && waypoints.length > 1) {
      badge.style.background = index === last ? '#111111' : legColor(index);
      badge.style.color = index === last ? '#f5efe6' : '#111111';
    }
    element.appendChild(badge);
    const time = options.times?.[index];
    if (time) {
      const chip = document.createElement('span');
      chip.className = 'wp-time';
      chip.dataset.testid = `waypoint-time-${index}`;
      chip.textContent = index === 0 ? `▶ ${time.clock}` : index === last ? `⚑ ${time.clock}` : time.clock;
      element.appendChild(chip);
    }
    element.addEventListener('contextmenu', event => {
      event.preventDefault();
      event.stopPropagation();
      options.onRemove?.(index);
    });
    const marker = new Marker({ element, anchor: 'center', draggable: Boolean(options.onMove) }).setLngLat([point.lng, point.lat]).addTo(map);
    marker.on('dragstart', () => element.classList.add('is-dragging'));
    marker.on('dragend', () => {
      element.classList.remove('is-dragging');
      const { lng, lat } = marker.getLngLat();
      options.onMove?.(index, { lng, lat });
    });
    return marker;
  });
  markers.set(map, drawn);
}

/** Pulse the markers while a route is being calculated. */
export function setWaypointsBusy(map: MapLibreMap, busy: boolean): void {
  for (const marker of markers.get(map) ?? []) marker.getElement().classList.toggle('is-busy', busy);
}

/** Remove every waypoint marker this module added to the map. */
export function clearWaypoints(map: MapLibreMap): void {
  for (const marker of markers.get(map) ?? []) marker.remove();
  markers.set(map, []);
}
