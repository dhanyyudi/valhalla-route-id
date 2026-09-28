/**
 * Ganjil-genap corridor geometry: turn the corridor centre-lines into the closed rings Valhalla's
 * `exclude_polygons` needs, and select the rings a single request can afford to carry.
 *
 * Pure and dependency-free by design: the browser bundle imports this module through the generated
 * `src/data/gage-polygons.json` only for its types, while the build script and the unit tests run
 * the same functions in Node, so the committed artifact and the asserted invariants cannot drift.
 */

/** One `[longitude, latitude]` pair in degrees, the order Valhalla expects inside a ring. */
export type LngLat = [number, number];

/** A closed ring: first and last coordinate identical. */
export interface CorridorRing {
  /** Ring vertices, longitude first, closed (last equals first). */
  coordinates: LngLat[];
  /** Great-circle ring length in metres — Valhalla's `max_exclude_polygons_length` counts this. */
  perimeterMeters: number;
  /** Enclosed area in square metres on a local equirectangular projection (Jakarta scale). */
  areaSquareMeters: number;
  /** `[minLng, minLat, maxLng, maxLat]`, for the cheap "is this ring near the route" test. */
  bounds: [number, number, number, number];
}

/** One named ganjil-genap corridor and the ring(s) that cover it. */
export interface CorridorPolygons {
  /** Source feature id, e.g. `gg_road_01`. */
  id: string;
  /** Corridor name exactly as the source data spells it, e.g. `Jl. Thamrin`. */
  name: string;
  /** The declared buffer half-width in metres (`bufferMeters` in the source data). */
  bufferMeters: number;
  /**
   * The corridor centre-line, longitude first.
   *
   * Carried through so the map draws the same geometry the rings were buffered from; it is never
   * sent to Valhalla.
   */
  centerline: LngLat[];
  /** One ring per uninterrupted piece of the corridor; more than one when the source is too long. */
  rings: CorridorRing[];
}

/** The whole generated artifact, minus the provenance block the build script adds. */
export interface CorridorRingSet {
  bufferMeters: number;
  /** Ring perimeter ceiling used when splitting; below the deployment's service limit. */
  maxRingPerimeterMeters: number;
  corridors: CorridorPolygons[];
}

/** Mean Earth radius (IUGG), the value Valhalla's Haversine strategy uses. */
const EARTH_RADIUS_METERS = 6371008.8;
const METERS_PER_DEGREE_LATITUDE = 111132;
const DEG = Math.PI / 180;

/**
 * Ring vertices are simplified before buffering: a point that moves the centre-line by less than a
 * tenth of the buffer cannot move the 35 m offset outline by more than that, and Valhalla
 * triangulates the ring it is given.
 */
const SIMPLIFY_TOLERANCE_METERS = 3.5;

/**
 * Longest a single ring may be. Valhalla throws exception 167 (`too_large_polygon`) when the summed
 * ring perimeters of one request exceed `service_limits.max_exclude_polygons_length`, which this
 * deployment sets to 10,000 m, so every generated ring must stay clear of that on its own.
 */
export const MAX_RING_PERIMETER_METERS = 9000;

/**
 * Summed ring perimeter one request may carry.
 *
 * The limit applies to the whole request, not per ring: once the selected rings add up to 10,000 m
 * Valhalla refuses the route outright, so the selector packs to this budget and leaves the rest to
 * the crossing report. It is deliberately below the service limit rather than equal to it.
 */
export const REQUEST_PERIMETER_BUDGET_METERS = 9500;

/** Great-circle distance between two coordinates, in metres. */
export function haversineMeters(a: LngLat, b: LngLat): number {
  const dLat = (b[1] - a[1]) * DEG;
  const dLng = (b[0] - a[0]) * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * DEG) * Math.cos(b[1] * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Great-circle length of an open or closed coordinate list. */
export function ringPerimeterMeters(coordinates: LngLat[]): number {
  let total = 0;
  for (let index = 0; index + 1 < coordinates.length; index += 1) total += haversineMeters(coordinates[index], coordinates[index + 1]);
  return total;
}

/**
 * Enclosed area of a closed ring, in square metres.
 * @remarks Shoelace formula on a local equirectangular projection. At Jakarta's scale (a few
 * kilometres) the projection error is far below the 25% tolerance the builder test allows.
 */
export function ringAreaSquareMeters(coordinates: LngLat[]): number {
  if (coordinates.length < 4) return 0;
  const reference = coordinates[0][1] * DEG;
  const project = ([lng, lat]: LngLat): [number, number] => [
    lng * METERS_PER_DEGREE_LATITUDE * Math.cos(reference),
    lat * METERS_PER_DEGREE_LATITUDE,
  ];
  let sum = 0;
  for (let index = 0; index + 1 < coordinates.length; index += 1) {
    const [x1, y1] = project(coordinates[index]);
    const [x2, y2] = project(coordinates[index + 1]);
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/** `[minLng, minLat, maxLng, maxLat]` of any non-empty coordinate list. */
export function coordinateBounds(coordinates: LngLat[]): [number, number, number, number] {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const [lng, lat] of coordinates) {
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLng, minLat, maxLng, maxLat];
}

/** Do two `[minLng, minLat, maxLng, maxLat]` boxes touch or overlap? */
export function boundsOverlap(a: [number, number, number, number], b: [number, number, number, number]): boolean {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

/**
 * Perpendicular distance from a point to a segment, in metres, on the same local projection.
 * @internal Exported for the simplify pass and its tests.
 */
function pointToSegmentMeters(point: LngLat, start: LngLat, end: LngLat): number {
  const reference = point[1] * DEG;
  const scale = METERS_PER_DEGREE_LATITUDE * Math.cos(reference);
  const px = point[0] * scale, py = point[1] * METERS_PER_DEGREE_LATITUDE;
  const ax = start[0] * scale, ay = start[1] * METERS_PER_DEGREE_LATITUDE;
  const bx = end[0] * scale, by = end[1] * METERS_PER_DEGREE_LATITUDE;
  const dx = bx - ax, dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Ramer–Douglas–Peucker simplification.
 *
 * Buffering a dense centre-line costs a pair of vertices per source vertex, and the source lines
 * come from a hand-drawn map: the points that are within a few metres of the line they belong to
 * add nothing to a 35 m buffer. Only the centre-line's own vertices are dropped; endpoints stay.
 */
export function simplifyLine(coordinates: LngLat[], toleranceMeters = SIMPLIFY_TOLERANCE_METERS): LngLat[] {
  if (coordinates.length <= 2) return coordinates.map(point => [...point] as LngLat);
  let worst = 0, worstIndex = 0;
  for (let index = 1; index < coordinates.length - 1; index += 1) {
    const distance = pointToSegmentMeters(coordinates[index], coordinates[0], coordinates[coordinates.length - 1]);
    if (distance > worst) { worst = distance; worstIndex = index; }
  }
  if (worst <= toleranceMeters) return [[...coordinates[0]] as LngLat, [...coordinates[coordinates.length - 1]] as LngLat];
  const left = simplifyLine(coordinates.slice(0, worstIndex + 1), toleranceMeters);
  const right = simplifyLine(coordinates.slice(worstIndex), toleranceMeters);
  return [...left.slice(0, -1), ...right];
}

/** A unit direction vector plus its length, in metres, on the local projection about `reference`. */
function segmentVector(from: LngLat, to: LngLat, reference: number): { x: number; y: number; length: number } | null {
  const scale = METERS_PER_DEGREE_LATITUDE * Math.cos(reference * DEG);
  const x = (to[0] - from[0]) * scale;
  const y = (to[1] - from[1]) * METERS_PER_DEGREE_LATITUDE;
  const length = Math.hypot(x, y);
  if (length < 1e-6) return null;
  return { x: x / length, y: y / length, length };
}

/** Where two infinite lines cross, or null when they are parallel. */
function lineIntersection(
  p: [number, number], d: [number, number], q: [number, number], e: [number, number],
): [number, number] | null {
  const denominator = d[0] * e[1] - d[1] * e[0];
  if (Math.abs(denominator) < 1e-9) return null;
  const t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / denominator;
  return [p[0] + t * d[0], p[1] + t * d[1]];
}

/**
 * One side's offset polyline, with the corner at each interior vertex resolved by intersecting the
 * two offset lines.
 *
 * A hand-drawn corridor is full of vertices that are not real corners — three points measured on
 * one straight road produce two nearly parallel offset lines and an intersection hundreds of metres
 * away. When the crossing lands further than `4 x buffer` along either segment the corner is
 * bevelled at the vertex instead, which keeps the ring bounded by the corridor and leaves a wedge
 * no wider than the buffer uncovered.
 */
function offsetSide(points: LngLat[], normals: Array<[number, number]>, buffer: number, side: 1 | -1): LngLat[] {
  const reference = points[0][1];
  const scale = METERS_PER_DEGREE_LATITUDE * Math.cos(reference * DEG);
  const unproject = (x: number, y: number): LngLat => [points[0][0] + x / scale, points[0][1] + y / METERS_PER_DEGREE_LATITUDE];
  const project = ([lng, lat]: LngLat): [number, number] => [(lng - points[0][0]) * scale, (lat - points[0][1]) * METERS_PER_DEGREE_LATITUDE];

  // Offset lines, one per segment: the origin is the segment's start moved sideways by the buffer,
  // and each line runs along the segment itself. (A first pass passed the *normal* as the line
  // direction, which made every corner intersection degenerate and every emitted vertex NaN.)
  const lines = normals.map((normal, index) => {
    const start = project(points[index]);
    const end = project(points[index + 1]);
    const dx = end[0] - start[0], dy = end[1] - start[1];
    const length = Math.hypot(dx, dy) || 1;
    const origin: [number, number] = [start[0] + side * buffer * normal[0], start[1] + side * buffer * normal[1]];
    return { origin, direction: [dx / length, dy / length] as [number, number] };
  });

  const result: LngLat[] = [unproject(lines[0].origin[0], lines[0].origin[1])];
  for (let index = 1; index < lines.length; index += 1) {
    const previous = lines[index - 1];
    const current = lines[index];
    const crossing = lineIntersection(previous.origin, previous.direction, current.origin, current.direction);
    const vertex = project(points[index]);
    const far = buffer * 4;
    const usable = crossing !== null
      && Math.hypot(crossing[0] - previous.origin[0], crossing[1] - previous.origin[1]) <= far + buffer
      && Math.hypot(crossing[0] - vertex[0], crossing[1] - vertex[1]) <= far;
    // Fall back to the vertex itself: a bevel, not an invented corner.
    if (usable && crossing) result.push(unproject(crossing[0], crossing[1]));
    else result.push(unproject(vertex[0] + side * buffer * current.direction[0], vertex[1] + side * buffer * current.direction[1]));
    result.push(unproject(current.origin[0], current.origin[1]));
  }
  // The last offset segment's own end point: without it the polyline stops one segment short, and a
  // two-point centre-line collapses to a cap-sized box (which is exactly what the area check caught).
  const tail = lines[lines.length - 1];
  const tailLength = segmentVector(points[points.length - 2], points[points.length - 1], points[0][1])!.length;
  result.push(unproject(tail.origin[0] + tail.direction[0] * tailLength, tail.origin[1] + tail.direction[1] * tailLength));
  return result;
}

/**
 * Buffer a polyline by `bufferMeters` on both sides and close it into a ring.
 *
 * Square end caps rather than arcs: a 35 m semicircle is 24 vertices, and the corners of a square
 * cap differ from it by at most 10 m. Perpendicular segment offsets plus the bevel rule above are
 * the whole construction — no external geometry dependency.
 *
 * @param coordinates - Centre-line vertices, longitude first.
 * @param bufferMeters - Half-width of the corridor, from the source data's `bufferMeters`.
 * @returns A closed ring; its first coordinate is repeated as its last.
 */
export function bufferPolyline(coordinates: LngLat[], bufferMeters: number): LngLat[] {
  const points = coordinates.filter((point, index) => index === 0 || haversineMeters(coordinates[index - 1], point) > 0.01);
  if (points.length < 2) throw new Error('bufferPolyline needs at least two distinct points');

  const reference = points[0][1] * DEG;
  const scale = METERS_PER_DEGREE_LATITUDE * Math.cos(reference);
  // Left normal of each travel direction. One vector per segment: an earlier version built separate
  // `{ normal, offset }` pairs whose two fields were the same array, so the offset lines had no
  // direction and `normal` was never the segment's own normal.
  const vectors = points.slice(0, -1).map((point, index) => {
    const vector = segmentVector(point, points[index + 1], points[0][1]);
    if (!vector) throw new Error(`bufferPolyline found a zero-length segment at index ${index}`);
    return { ...vector, normal: [-vector.y, vector.x] as [number, number] };
  });
  const normals = vectors.map(vector => vector.normal);

  const left = offsetSide(points, normals, bufferMeters, 1);
  const right = offsetSide(points, normals, bufferMeters, -1);

  const project = ([lng, lat]: LngLat): [number, number] => [(lng - points[0][0]) * scale, (lat - points[0][1]) * METERS_PER_DEGREE_LATITUDE];
  const unproject = (x: number, y: number): LngLat => [points[0][0] + x / scale, points[0][1] + y / METERS_PER_DEGREE_LATITUDE];

  const last = vectors[vectors.length - 1];
  const first = vectors[0];
  // Square caps: the outward normal at each end, walked across the corridor width.
  const endLeft = project(left[left.length - 1]);
  const endRight = project(right[right.length - 1]);
  const endCap: LngLat[] = [
    unproject(endLeft[0] + bufferMeters * last.x, endLeft[1] + bufferMeters * last.y),
    unproject(endRight[0] + bufferMeters * last.x, endRight[1] + bufferMeters * last.y),
  ];
  const startLeft = project(left[0]);
  const startRight = project(right[0]);
  const startCap: LngLat[] = [
    unproject(startRight[0] - bufferMeters * first.x, startRight[1] - bufferMeters * first.y),
    unproject(startLeft[0] - bufferMeters * first.x, startLeft[1] - bufferMeters * first.y),
  ];

  const ring = [...left, ...endCap, ...right.slice().reverse(), ...startCap];
  ring.push([...ring[0]] as LngLat);
  return ring;
}

/** Measure a ring the way the artifact records it. */
export function describeRing(coordinates: LngLat[]): CorridorRing {
  const closed = coordinates.length > 0 && coordinates[0][0] === coordinates[coordinates.length - 1][0]
    && coordinates[0][1] === coordinates[coordinates.length - 1][1];
  if (!closed) throw new Error('describeRing needs a closed ring');
  return {
    coordinates,
    perimeterMeters: Math.round(ringPerimeterMeters(coordinates) * 100) / 100,
    areaSquareMeters: Math.round(ringAreaSquareMeters(coordinates)),
    bounds: coordinateBounds(coordinates),
  };
}

/** Total great-circle length of a polyline. */
export function lineLengthMeters(coordinates: LngLat[]): number {
  let total = 0;
  for (let index = 0; index + 1 < coordinates.length; index += 1) total += haversineMeters(coordinates[index], coordinates[index + 1]);
  return total;
}

/**
 * Cut a polyline into `count` pieces of near-equal length, cutting inside a segment when a boundary
 * falls inside one.
 *
 * Equal pieces matter because a 35 m buffer costs the same 4 x 35 m of end cap whatever the piece's
 * length: an uneven split leaves a stub whose perimeter is all cap, and a dozen of those would eat
 * the request budget the corridor itself needs.
 */
export function splitLineEvenly(coordinates: LngLat[], count: number): LngLat[][] {
  if (count <= 1) return [coordinates.map(point => [...point] as LngLat)];
  const total = lineLengthMeters(coordinates);
  const step = total / count;
  const pieces: LngLat[][] = [];
  let current: LngLat[] = [[...coordinates[0]] as LngLat];
  let travelled = 0;
  let boundaries = 1;
  for (let index = 0; index + 1 < coordinates.length; index += 1) {
    const from = coordinates[index];
    const to = coordinates[index + 1];
    const length = haversineMeters(from, to);
    let consumed = 0;
    while (boundaries < count && travelled + (length - consumed) >= boundaries * step) {
      const ratio = (boundaries * step - travelled) / (length - consumed);
      const cut: LngLat = [from[0] + (to[0] - from[0]) * ratio, from[1] + (to[1] - from[1]) * ratio];
      current.push(cut);
      pieces.push(current);
      current = [cut];
      consumed += (length - consumed) * ratio;
      boundaries += 1;
    }
    current.push(to);
    travelled += length - consumed;
  }
  pieces.push(current);
  return pieces.filter(piece => piece.length >= 2);
}

/**
 * The pieces of a corridor's centre-line that each become one ring.
 *
 * Normally the corridor is one piece. A corridor whose 35 m outline exceeds
 * `maxRingPerimeterMeters` is cut into equal pieces instead, because a single ring that long cannot
 * be sent at all — Valhalla answers 400 `too_large_polygon` (native 167) once a request's rings sum
 * past `service_limits.max_exclude_polygons_length`. The pieces are disjoint but adjacent, so the
 * union of their rings is the corridor's buffer minus a cap-width strip at each cut; the crossing
 * check uses the same rings, so what the panel reports and what the router avoided stay the same
 * geometry.
 *
 * @param centerline - The corridor's vertices, longitude first.
 * @param bufferMeters - Half-width of the buffer.
 * @param maxRingPerimeterMeters - Per-ring perimeter ceiling.
 * @returns One or more polylines, in travel order.
 * @remarks Exported because the builder test measures each ring against the piece it came from.
 */
export function corridorPieces(
  centerline: LngLat[],
  bufferMeters: number,
  maxRingPerimeterMeters: number = MAX_RING_PERIMETER_METERS,
): LngLat[][] {
  const line = simplifyLine(centerline);
  if (describeRing(bufferPolyline(line, bufferMeters)).perimeterMeters <= maxRingPerimeterMeters) return [line];
  // A piece's perimeter is 2 x its length plus 4 x buffer; solve for the length that fits, then
  // round up to a whole number of pieces so the split is even.
  const allowed = Math.max(bufferMeters * 8, (maxRingPerimeterMeters - 4 * bufferMeters) / 2);
  const pieces = splitLineEvenly(line, Math.ceil(lineLengthMeters(line) / allowed));
  // A source vertex can jump further than one piece may run: re-split anything still too long.
  const bounded: LngLat[][] = [];
  for (const piece of pieces) {
    if (describeRing(bufferPolyline(piece, bufferMeters)).perimeterMeters <= maxRingPerimeterMeters) bounded.push(piece);
    else bounded.push(...splitLineEvenly(piece, 2));
  }
  return bounded;
}

/**
 * Every ring for one corridor: `corridorPieces` buffered, in order.
 *
 * @param centerline - The corridor's vertices, longitude first.
 * @param bufferMeters - Half-width of the buffer, from the source data's `bufferMeters`.
 * @param maxRingPerimeterMeters - Per-ring perimeter ceiling.
 * @returns One ring per piece; each is closed and measured.
 */
export function corridorRings(
  centerline: LngLat[],
  bufferMeters: number,
  maxRingPerimeterMeters: number = MAX_RING_PERIMETER_METERS,
): CorridorRing[] {
  return corridorPieces(centerline, bufferMeters, maxRingPerimeterMeters)
    .map(piece => describeRing(bufferPolyline(piece, bufferMeters)));
}

/** One corridor's ring chosen for a request. */
export interface SelectedRing {
  /** The corridor the ring belongs to. */
  corridor: CorridorPolygons;
  /** Index into `corridor.rings`, so the caller can name the chunk. */
  ringIndex: number;
  /** The ring itself. */
  ring: CorridorRing;
  /** True when the corridor has more rings than this one and they are not all being sent. */
  partial: boolean;
}

/** What one request may carry, and what it had to leave behind. */
export interface RingSelection {
  /** Rings to send, in the artifact's own corridor order and then ring order. */
  rings: SelectedRing[];
  /** Corridors fully covered by `rings`, in the artifact's own order. */
  selected: CorridorPolygons[];
  /** Corridors the route could reach that are not fully covered, with the rings that were sent. */
  omitted: CorridorPolygons[];
  /** Summed perimeter of `rings`, in metres. */
  perimeterMeters: number;
}

/** Overlap area of two `[minLng, minLat, maxLng, maxLat]` boxes; zero when they only touch. */
function boxOverlapArea(a: [number, number, number, number], b: [number, number, number, number]): number {
  const width = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const height = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return Math.max(0, width) * Math.max(0, height);
}

/**
 * Choose the rings to exclude for one route.
 *
 * Two limits decide this, and the second is the sharp one. Only rings whose bounding box the
 * route's own box (grown by the buffer) touches are candidates — nothing else can be crossed. The
 * survivors are then packed one *ring* at a time, the largest overlap with the route's box first,
 * until the request's summed perimeter reaches `REQUEST_PERIMETER_BUDGET_METERS`.
 *
 * Packing per ring rather than per corridor matters because Valhalla sums `boost::geometry::perimeter`
 * over every ring in a request and refuses the whole request above
 * `service_limits.max_exclude_polygons_length` (10,000 m here — probed as native error 167). The 25
 * corridors are ~141 km of ring between them, so no request can carry the network: about 9.5 km is
 * the whole budget, which is two or three of these rings. Sending the rings that overlap the route
 * most is therefore the best a single request can do, and the crossing report names the rest.
 *
 * @param route - Route geometry as `[lng, lat]`, or the planned waypoints when no route exists yet.
 * @param corridors - The generated corridors.
 * @param bufferMeters - Buffer half-width, used to grow the route's bounding box.
 * @param budgetMeters - Ring-perimeter budget for this request.
 * @returns The rings to send, the corridors they cover, those left out, and the perimeter requested.
 * @remarks Deterministic: candidates are ranked by overlap area then by the artifact's own order, and
 *   the returned rings are re-sorted into that same order before they leave.
 */
export function selectCorridorsForRoute(
  route: LngLat[],
  corridors: CorridorPolygons[],
  bufferMeters: number,
  budgetMeters: number = REQUEST_PERIMETER_BUDGET_METERS,
): RingSelection {
  if (route.length === 0) return { rings: [], selected: [], omitted: [], perimeterMeters: 0 };
  const routeBounds = coordinateBounds(route);
  const latDegrees = bufferMeters / METERS_PER_DEGREE_LATITUDE;
  const lngDegrees = bufferMeters / (METERS_PER_DEGREE_LATITUDE * Math.cos(routeBounds[1] * DEG));
  const grown: [number, number, number, number] = [
    routeBounds[0] - lngDegrees, routeBounds[1] - latDegrees,
    routeBounds[2] + lngDegrees, routeBounds[3] + latDegrees,
  ];

  const candidates = corridors.flatMap((corridor, corridorIndex) => corridor.rings.map((ring, ringIndex) => ({
    corridor, corridorIndex, ring, ringIndex, overlap: boxOverlapArea(grown, ring.bounds),
  })))
    .filter(candidate => candidate.overlap > 0)
    .sort((a, b) => (b.overlap - a.overlap) || (a.corridorIndex - b.corridorIndex) || (a.ringIndex - b.ringIndex));

  const chosen: Array<{ corridor: CorridorPolygons; corridorIndex: number; ringIndex: number; ring: CorridorRing }> = [];
  let perimeterMeters = 0;
  for (const candidate of candidates) {
    if (perimeterMeters + candidate.ring.perimeterMeters > budgetMeters) continue;
    chosen.push(candidate);
    perimeterMeters += candidate.ring.perimeterMeters;
  }
  chosen.sort((a, b) => (a.corridorIndex - b.corridorIndex) || (a.ringIndex - b.ringIndex));

  const sentPerCorridor = new Map<string, number>();
  for (const entry of chosen) sentPerCorridor.set(entry.corridor.id, (sentPerCorridor.get(entry.corridor.id) ?? 0) + 1);

  const rings: SelectedRing[] = chosen.map(entry => ({
    corridor: entry.corridor,
    ringIndex: entry.ringIndex,
    ring: entry.ring,
    partial: entry.corridor.rings.length > 1 && (sentPerCorridor.get(entry.corridor.id) ?? 0) < entry.corridor.rings.length,
  }));
  const selected = corridors.filter(corridor => (sentPerCorridor.get(corridor.id) ?? 0) === corridor.rings.length);
  const omitted = corridors.filter(corridor => {
    const sent = sentPerCorridor.get(corridor.id) ?? 0;
    return sent > 0 && sent < corridor.rings.length;
  });
  return { rings, selected, omitted, perimeterMeters: Math.round(perimeterMeters * 100) / 100 };
}

/**
 * Encode rings for the native request.
 *
 * Valhalla's JSON parser reads `exclude_polygons` as an array whose entries are either rings or
 * GeoJSON feature objects, and `parse_ring` takes `coords[0]` as longitude and `coords[1]` as
 * latitude (src/worker.cc). A ring is therefore `[[lon, lat], ...]` — nested arrays, not the
 * comma-separated string the spike used, which the parser reads as one coordinate per character
 * and silently ignores. Native closes an open ring itself, but the generated rings are already
 * closed.
 */
export function encodeExcludePolygons(rings: Array<{ ring: CorridorRing }>): number[][][] {
  return rings.map(({ ring }) => ring.coordinates.map(([lng, lat]) => [lng, lat]));
}
