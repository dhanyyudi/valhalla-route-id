/**
 * Crossing report: after a route comes back, which ganjil-genap corridors does it still run
 * through?
 *
 * This is the honest half of the feature. `exclude_polygons` constrains the search but does not
 * guarantee a path outside every ring — a corridor can be unavoidable (the only bridge, the only
 * one-way pair, the last few metres to the door), and only the corridors whose rings fit the
 * request's perimeter budget are sent at all. So the same buffered rings that were handed to
 * Valhalla are intersected against the returned geometry, and whatever still crosses is named.
 *
 * Pure and synchronous: no React, no map, no I/O. `src/state/scenario.ts` calls the functions here
 * with the same ring array it drew on the map and packed into the request, so the answer is a
 * property of the geometry rather than of what MapLibre happens to have rendered.
 */
import {
  boundsOverlap,
  coordinateBounds,
  type CorridorPolygons,
  type CorridorRing,
  type LngLat,
} from './gage-geometry';

/** One corridor the route still runs through. */
export interface CorridorCrossing {
  /** Source feature id, e.g. `gg_road_01`. */
  id: string;
  /** Corridor name as the source data spells it, e.g. `Jl. Thamrin`. */
  name: string;
  /** Number of ring polygons of this corridor the route intersects (1 unless it was chunked). */
  rings: number;
  /** How many of the route's segments crossed a ring; a longer overlap scores higher. */
  segments: number;
}

/** The panel's crossing report. */
export interface CrossingReport {
  /** Distinct corridors crossed, in the artifact's own order. */
  corridors: CorridorCrossing[];
  /** Length of `corridors`, for the headline. */
  count: number;
}

/** Is a point inside a ring? Ray casting; a point exactly on an edge counts as inside. */
function pointInRing(point: LngLat, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > point[1]) !== (yj > point[1])
      && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Signed area sign of the triangle abc; zero when the three points are collinear. */
function orientation(a: LngLat, b: LngLat, c: LngLat): number {
  const value = (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1]);
  if (Math.abs(value) < 1e-15) return 0;
  return value > 0 ? 1 : -1;
}

/** Do segments ab and cd properly cross, or touch? */
function segmentsIntersect(a: LngLat, b: LngLat, c: LngLat, d: LngLat): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  // Collinear touches: a route running along a corridor edge still crosses the corridor.
  const onSegment = (p: LngLat, q: LngLat, r: LngLat) =>
    Math.min(p[0], r[0]) <= q[0] && q[0] <= Math.max(p[0], r[0])
    && Math.min(p[1], r[1]) <= q[1] && q[1] <= Math.max(p[1], r[1]);
  if (o1 === 0 && onSegment(a, c, b)) return true;
  if (o2 === 0 && onSegment(a, d, b)) return true;
  if (o3 === 0 && onSegment(c, a, d)) return true;
  return o4 === 0 && onSegment(c, b, d);
}

/** Does one route segment meet one buffered ring? */
function segmentCrossesRing(segment: [LngLat, LngLat], ring: CorridorRing): boolean {
  const [a, b] = segment;
  const segmentBounds = coordinateBounds([a, b]);
  if (!boundsOverlap(segmentBounds, ring.bounds)) return false;
  if (pointInRing(a, ring.coordinates) || pointInRing(b, ring.coordinates)) return true;
  for (let index = 0; index + 1 < ring.coordinates.length; index += 1) {
    if (segmentsIntersect(a, b, ring.coordinates[index], ring.coordinates[index + 1])) return true;
  }
  return false;
}

/**
 * Intersect one geometry against the buffered corridors.
 *
 * @param geometry - Route coordinates as `[lng, lat]`, as returned by `routeCoordinates`.
 * @param corridors - The generated corridors with their buffered rings.
 * @returns The corridors the geometry runs through, in the artifact's order, with a count.
 * @remarks A geometry with fewer than two points, or none, reports zero crossings — a cancelled or
 * empty route has not been shown to cross anything.
 */
export function findCorridorCrossings(geometry: LngLat[], corridors: CorridorPolygons[]): CrossingReport {
  if (geometry.length < 2) return { corridors: [], count: 0 };
  const found = new Map<string, CorridorCrossing>();
  for (const corridor of corridors) {
    let rings = 0;
    let segments = 0;
    for (const ring of corridor.rings) {
      let hit = false;
      for (let index = 0; index + 1 < geometry.length; index += 1) {
        if (segmentCrossesRing([geometry[index], geometry[index + 1]], ring)) {
          hit = true;
          segments += 1;
        }
      }
      if (hit) rings += 1;
    }
    if (rings > 0) found.set(corridor.id, { id: corridor.id, name: corridor.name, rings, segments });
  }
  const corridorsCrossed = corridors.map(corridor => found.get(corridor.id)).filter((entry): entry is CorridorCrossing => entry !== undefined);
  return { corridors: corridorsCrossed, count: corridorsCrossed.length };
}

/**
 * Build a report from feature-like `{ id, name }` properties, merging repeats by corridor id.
 *
 * The shape adapter for callers that hold the corridor artifact as GeoJSON features rather than as
 * rings; it is the same `CrossingReport` `findCorridorCrossings` returns, and the ring count it
 * cannot know is filled in only by that function.
 *
 * @param features - `properties` of each hit: `id` and `name` from the artifact.
 * @returns The merged corridors, one entry per distinct id, in first-seen order.
 */
export function featuresToCrossings(features: Array<{ id?: unknown; name?: unknown }>): CrossingReport {
  const merged = new Map<string, CorridorCrossing>();
  for (const feature of features) {
    if (typeof feature.id !== 'string' || typeof feature.name !== 'string') continue;
    const existing = merged.get(feature.id);
    if (existing) { existing.rings += 1; existing.segments += 1; continue; }
    merged.set(feature.id, { id: feature.id, name: feature.name, rings: 1, segments: 1 });
  }
  const corridors = [...merged.values()];
  return { corridors, count: corridors.length };
}

/**
 * One Indonesian sentence for the panel.
 * @param report - The crossing report.
 * @param avoidedCorridors - How many distinct corridors the request asked Valhalla to avoid — the
 *   unit the sentence names ("ruas"), never the number of rings the request carried.
 * @returns A sentence that never claims more than the geometry shows.
 */
export function describeCrossings(report: CrossingReport, avoidedCorridors: number): string {
  if (report.count === 0) {
    return avoidedCorridors > 0
      ? `Tidak ada ruas ganjil-genap yang masih dilintasi (${avoidedCorridors} ruas diminta dihindari).`
      : 'Tidak ada ruas ganjil-genap yang dilintasi.';
  }
  const names = report.corridors.map(corridor => corridor.name).join(', ');
  return `Masih melintasi ${report.count} ruas ganjil-genap: ${names}.`;
}
