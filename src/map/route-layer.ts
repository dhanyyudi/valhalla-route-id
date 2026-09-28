import { Marker, type Map as MapLibreMap } from 'maplibre-gl';
import type { RouteResult } from 'valhalla-browser';
import type { Waypoint } from '../core/request-builder';

const SOURCE = 'route';
const LINE = 'route-line';
/** Terracotta, matching the design token `--color-nb-terracotta`. */
const ROUTE_COLOR = '#c8553d';

/** Live waypoint markers per map, so a redraw replaces them instead of stacking them. */
const markers = new WeakMap<MapLibreMap, Marker[]>();

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

/**
 * Draw (or redraw) the route polyline.
 * @param map - Loaded MapLibre map.
 * @param result - Native route result whose leg shapes become one LineString.
 * @returns The number of coordinates drawn; zero means the response carried no geometry.
 */
export function drawRoute(map: MapLibreMap, result: RouteResult): number {
  const coordinates = routeCoordinates(result);
  const data = { type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates } };
  const existing = map.getSource(SOURCE) as { setData(data: unknown): void } | undefined;
  if (existing) {
    existing.setData(data);
    return coordinates.length;
  }
  map.addSource(SOURCE, { type: 'geojson', data });
  map.addLayer({
    id: LINE,
    type: 'line',
    source: SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ROUTE_COLOR, 'line-width': 5 },
  });
  return coordinates.length;
}

/** Remove the route layer and source, if either exists. */
export function clearRoutes(map: MapLibreMap): void {
  if (map.getLayer(LINE)) map.removeLayer(LINE);
  if (map.getSource(SOURCE)) map.removeSource(SOURCE);
}

/**
 * Draw one numbered marker per waypoint, replacing any markers already on the map.
 * @param map - Loaded MapLibre map.
 * @param waypoints - Stops in visit order; the marker number is the index plus one.
 */
export function drawWaypoints(map: MapLibreMap, waypoints: Waypoint[]): void {
  clearWaypoints(map);
  const drawn = waypoints.map((point, index) => {
    const element = document.createElement('div');
    element.textContent = String(index + 1);
    element.dataset.waypoint = String(index + 1);
    element.style.cssText = [
      'width:28px', 'height:28px', 'display:flex', 'align-items:center', 'justify-content:center',
      'border:3px solid #111111', 'background:#f2c14e', 'color:#111111', 'font:700 14px/1 "Space Grotesk", system-ui, sans-serif',
      'box-shadow:3px 3px 0 #111111',
    ].join(';');
    return new Marker({ element, anchor: 'center' }).setLngLat([point.lng, point.lat]).addTo(map);
  });
  markers.set(map, drawn);
}

/** Remove every waypoint marker this module added to the map. */
export function clearWaypoints(map: MapLibreMap): void {
  for (const marker of markers.get(map) ?? []) marker.remove();
  markers.set(map, []);
}
