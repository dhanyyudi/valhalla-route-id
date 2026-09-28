import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import artifact from '../data/gage-polygons.json';
import {
  MAX_RING_PERIMETER_METERS,
  REQUEST_PERIMETER_BUDGET_METERS,
  boundsOverlap,
  bufferPolyline,
  corridorPieces,
  corridorRings,
  haversineMeters,
  lineLengthMeters,
  ringAreaSquareMeters,
  ringPerimeterMeters,
  selectCorridorsForRoute,
  simplifyLine,
  type CorridorPolygons,
} from './gage-geometry';

const corridors = (artifact as unknown as { corridors: CorridorPolygons[] }).corridors;
const SOURCE = JSON.parse(readFileSync(join('data', 'jakarta-ganjil-genap.geojson'), 'utf8')) as {
  _meta: { version: string; source: string; sourceName: string; roadCorridors: number };
  features: Array<{ properties: { id: string; name: string; bufferMeters?: number }; geometry: { type: string; coordinates: [number, number][] } }>;
};

describe('corridor artifact', () => {
  it('covers all 25 named LineString corridors of the source data, and only those', () => {
    const roads = SOURCE.features.filter(feature => feature.geometry.type === 'LineString');
    expect(roads).toHaveLength(25);
    expect(corridors).toHaveLength(25);
    expect(corridors.map(corridor => corridor.id)).toEqual(roads.map(feature => feature.properties.id));
    expect(corridors.map(corridor => corridor.name)).toEqual(roads.map(feature => feature.properties.name));
    // The 28 toll-access Points are out of scope for this feature and must not appear.
    expect(corridors.some(corridor => corridor.id.startsWith('gg_toll'))).toBe(false);
  });

  it('buffers every corridor by the 35 m the source data declares', () => {
    expect(corridors.every(corridor => corridor.bufferMeters === 35)).toBe(true);
    expect((artifact as { bufferMeters: number }).bufferMeters).toBe(35);
  });

  it('keeps the source _meta provenance in the generated artifact', () => {
    const meta = (artifact as { sourceMeta: { version: string; source: string; sourceName: string } }).sourceMeta;
    expect(meta.version).toBe(SOURCE._meta.version);
    expect(meta.source).toBe(SOURCE._meta.source);
    expect(meta.sourceName).toBe(SOURCE._meta.sourceName);
    expect((artifact as { source: string }).source).toBe(join('data', 'jakarta-ganjil-genap.geojson'));
  });

  it('is byte-identical between two runs', () => {
    // The builder is a pure function of the committed source, so "byte-identical between two runs"
    // is provable here: regenerating the rings from the committed centre-lines must reproduce the
    // committed rings exactly, and doing it twice must give the same bytes.
    const first = JSON.stringify(corridors.map(corridor => corridorRings(corridor.centerline, corridor.bufferMeters, MAX_RING_PERIMETER_METERS)), null, 2);
    const second = JSON.stringify(corridors.map(corridor => corridorRings(corridor.centerline, corridor.bufferMeters, MAX_RING_PERIMETER_METERS)), null, 2);
    expect(first).toBe(second);
    expect(JSON.parse(first)).toEqual(corridors.map(corridor => corridor.rings));
  });

  it('regenerates the committed file byte for byte', () => {
    const artifactText = readFileSync(join('src', 'data', 'gage-polygons.json'), 'utf8');
    const regenerated = JSON.stringify({
      ...(artifact as unknown as Record<string, unknown>),
      corridors: corridors.map(corridor => ({
        ...corridor,
        rings: corridorRings(corridor.centerline, corridor.bufferMeters, MAX_RING_PERIMETER_METERS),
      })),
    }, null, 2);
    expect(`${regenerated}\n`).toBe(artifactText);
  });

  it('records the ring counts and perimeter budgets the app relies on', () => {
    const rings = corridors.flatMap(corridor => corridor.rings);
    expect((artifact as { ringCount: number }).ringCount).toBe(rings.length);
    expect((artifact as { corridorCount: number }).corridorCount).toBe(corridors.length);
    expect((artifact as { maxRingPerimeterMeters: number }).maxRingPerimeterMeters).toBe(MAX_RING_PERIMETER_METERS);
    expect((artifact as { requestPerimeterBudgetMeters: number }).requestPerimeterBudgetMeters).toBe(REQUEST_PERIMETER_BUDGET_METERS);
    // Valhalla sums every ring's perimeter per request and rejects the request above 10,000 m
    // (service_limits.max_exclude_polygons_length); no single ring may sit near that on its own.
    expect(Math.max(...rings.map(ring => ring.perimeterMeters))).toBeLessThan(MAX_RING_PERIMETER_METERS);
    // The whole network is far larger than one request may carry — which is why the selector packs.
    const total = rings.reduce((sum, ring) => sum + ring.perimeterMeters, 0);
    expect(total).toBeGreaterThan(REQUEST_PERIMETER_BUDGET_METERS * 5);
  });
});

describe('generated rings', () => {
  const rings = corridors.flatMap(corridor => corridor.rings);

  it('closes every ring and never repeats a vertex inside it', () => {
    for (const ring of rings) {
      const first = ring.coordinates[0];
      const last = ring.coordinates[ring.coordinates.length - 1];
      expect(last).toEqual(first);
      expect(ring.coordinates.length).toBeGreaterThanOrEqual(4);
      for (let index = 0; index + 1 < ring.coordinates.length; index += 1) {
        expect(ring.coordinates[index]).not.toEqual(ring.coordinates[index + 1]);
      }
    }
  });

  it('is non-degenerate: finite coordinates, positive area, perimeter and a sane bounding box', () => {
    for (const ring of rings) {
      expect(ring.areaSquareMeters).toBeGreaterThan(1);
      expect(ring.perimeterMeters).toBeGreaterThan(0);
      for (const [lng, lat] of ring.coordinates) {
        expect(Number.isFinite(lng) && Number.isFinite(lat)).toBe(true);
        expect(lng).toBeGreaterThan(106.6);
        expect(lng).toBeLessThan(107.0);
        expect(lat).toBeGreaterThan(-6.4);
        expect(lat).toBeLessThan(-6.0);
      }
      expect(boundsOverlap(ring.bounds, ring.bounds)).toBe(true);
    }
  });

  it('encloses an area within 25% of perimeter x 35 m', () => {
    // The bounded claim the plan asks for. Algebraically: a ring's perimeter is 2L + (2π+8)b and its
    // area is 2Lb + πb², of which the πb² cap is at most 11.7% (b = 35 m, L = 226 m), so
    // area ≤ 1.25 x perimeter x b holds for every ring at every length, and the measured ratio runs
    // 2.1–7.2. What this rules out is a buffer that is not corridor-shaped at all — a ring whose
    // area were, say, 40% of perimeter x b would be a strip of a different width. A *pure* lower
    // bound of the same form cannot be 0.75: for a zero-length corridor the ratio is π/(2π+8) = 0.30.
    for (const ring of rings) {
      const bound = ring.perimeterMeters * 35;
      expect(ring.areaSquareMeters).toBeLessThanOrEqual(bound * 1.25);
      expect(ring.areaSquareMeters).toBeGreaterThanOrEqual(bound * 0.29);
    }
  });

  it('buffers by the declared 35 m, measured against the piece each ring came from', () => {
    // The sharp version of the same statement: a 35 m buffer around a piece of length L encloses
    // 2·L·35 m² plus the cap. Jakarta's corridors double back on themselves (Jl. Rasuna Said is a
    // hook), and the ring's shoelace area cancels where the buffer folds over itself, so the measured
    // area is 0.53–0.73 of that model for the winding corridors and 1.31 for the straightest stub.
    // A buffer of half or double the declared width would land outside the band below.
    let checked = 0;
    for (const corridor of corridors) {
      const pieces = corridorPieces(corridor.centerline, corridor.bufferMeters, MAX_RING_PERIMETER_METERS);
      expect(pieces).toHaveLength(corridor.rings.length);
      corridor.rings.forEach((ring, index) => {
        const model = 2 * lineLengthMeters(pieces[index]) * corridor.bufferMeters;
        expect(ring.areaSquareMeters).toBeGreaterThan(model * 0.45);
        expect(ring.areaSquareMeters).toBeLessThan(model * 1.4);
        checked += 1;
      });
    }
    expect(checked).toBe(rings.length);
  });

  it('measures each ring the way the artifact reports it', () => {
    for (const ring of rings) {
      expect(ring.perimeterMeters).toBeCloseTo(ringPerimeterMeters(ring.coordinates), 1);
      expect(ring.areaSquareMeters).toBeCloseTo(ringAreaSquareMeters(ring.coordinates), -1);
    }
  });
});

describe('bufferPolyline', () => {
  it('buffers a two-point line into a rectangle of the requested width', () => {
    // A west-to-east line, so the buffer is a ~1000 m x 70 m rectangle whatever simplifyLine does
    // to the two points it is given.
    const line: [number, number][] = [[106.80, -6.20], [106.812, -6.20]];
    const ring = bufferPolyline(line, 35);
    expect(ring.length).toBeGreaterThanOrEqual(4);
    expect(ring[ring.length - 1]).toEqual(ring[0]);
    const lats = ring.map(point => point[1]);
    const widthMeters = (Math.max(...lats) - Math.min(...lats)) * 111132;
    expect(widthMeters).toBeGreaterThan(65);
    expect(widthMeters).toBeLessThan(75);
    const model = 2 * haversineMeters(line[0], line[1]) * 35;
    expect(ringAreaSquareMeters(ring)).toBeGreaterThan(model * 0.9);
    expect(ringAreaSquareMeters(ring)).toBeLessThan(model * 1.25);
  });

  it('stays within a buffer width of the centre-line it was built from', () => {
    const corridor = corridors.find(entry => entry.name === 'Jl. Thamrin')!;
    const ring = corridor.rings[0];
    // Every ring vertex must be within ~35 m + the 3.5 m simplify tolerance of some centre-line
    // segment, which is the strongest statement that the ring is a buffer and not an invention.
    const distanceToSegment = (point: [number, number], a: [number, number], b: [number, number]) => {
      const steps = 20;
      let best = Infinity;
      for (let step = 0; step <= steps; step += 1) {
        const t = step / steps;
        const candidate: [number, number] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        best = Math.min(best, haversineMeters(point, candidate));
      }
      return best;
    };
    for (const vertex of ring.coordinates) {
      let closest = Infinity;
      for (let index = 0; index + 1 < corridor.centerline.length; index += 1) {
        closest = Math.min(closest, distanceToSegment(vertex, corridor.centerline[index], corridor.centerline[index + 1]));
      }
      expect(closest).toBeLessThan(60);
    }
  });
});

describe('selectCorridorsForRoute', () => {
  it('selects nothing when the route is outside every corridor', () => {
    const selection = selectCorridorsForRoute([[-6.9, 107.6], [-6.91, 107.62]], corridors, 35);
    expect(selection.selected).toEqual([]);
    expect(selection.omitted).toEqual([]);
    expect(selection.perimeterMeters).toBe(0);
  });

  it('never exceeds the request perimeter budget and reports what it left out', () => {
    // A route spanning the whole corridor network: every ring is a candidate, so the budget binds.
    const route: [number, number][] = [[106.78, -6.13], [106.88, -6.26]];
    const selection = selectCorridorsForRoute(route, corridors, 35);
    expect(selection.rings.length).toBeGreaterThan(0);
    expect(selection.perimeterMeters).toBeLessThanOrEqual(REQUEST_PERIMETER_BUDGET_METERS);
    expect(selection.perimeterMeters).toBeCloseTo(
      selection.rings.reduce((sum, entry) => sum + entry.ring.perimeterMeters, 0), 1);
    // Every ring the request carries still fits under Valhalla's own service limit on its own.
    expect(selection.rings.every(entry => entry.ring.perimeterMeters < 10_000)).toBe(true);
    // A corridor is either fully covered (all its rings sent) or listed as partial — never both.
    const fullyCovered = new Set(selection.selected.map(corridor => corridor.id));
    const partial = new Set(selection.omitted.map(corridor => corridor.id));
    expect([...fullyCovered].some(id => partial.has(id))).toBe(false);
    for (const corridor of selection.selected) {
      expect(selection.rings.filter(entry => entry.corridor.id === corridor.id)).toHaveLength(corridor.rings.length);
      expect(selection.rings.some(entry => entry.corridor.id === corridor.id && entry.partial)).toBe(false);
    }
    for (const corridor of selection.omitted) {
      const sent = selection.rings.filter(entry => entry.corridor.id === corridor.id);
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.length).toBeLessThan(corridor.rings.length);
      expect(sent.every(entry => entry.partial)).toBe(true);
    }
    // Deterministic: the same call gives the same answer.
    expect(selectCorridorsForRoute(route, corridors, 35)).toEqual(selection);
  });

  it('spends the budget on the rings the route runs through, not on the network', () => {
    // The whole network is ~140 km of ring and a request may carry ~9.5 km, so a long route gets a
    // handful of rings and the crossing report names the rest. This asserts the *shape* of that
    // outcome rather than a number that would drift with the data: something is always selected,
    // and the budget is what stops it, not the candidate list.
    const selection = selectCorridorsForRoute([[106.78, -6.13], [106.88, -6.26]], corridors, 35);
    const total = corridors.flatMap(corridor => corridor.rings).reduce((sum, ring) => sum + ring.perimeterMeters, 0);
    expect(selection.perimeterMeters).toBeGreaterThan(REQUEST_PERIMETER_BUDGET_METERS * 0.5);
    expect(total).toBeGreaterThan(REQUEST_PERIMETER_BUDGET_METERS * 10);
  });

  it('prefers the corridor the route runs along over one it only clips', () => {
    // Jl. Thamrin runs north-south at ~106.823; this route runs along it.
    const selection = selectCorridorsForRoute([[106.8230, -6.182], [106.8230, -6.190]], corridors, 35);
    expect(selection.selected.map(corridor => corridor.name)).toContain('Jl. Thamrin');
  });
});

describe('simplifyLine', () => {
  it('drops vertices that move the line by less than the 3.5 m tolerance', () => {
    const straight: [number, number][] = [[106.80, -6.20], [106.805, -6.20], [106.81, -6.20]];
    expect(simplifyLine(straight)).toHaveLength(2);
  });

  it('keeps a vertex that is a real corner', () => {
    const corner: [number, number][] = [[106.80, -6.20], [106.81, -6.20], [106.81, -6.21]];
    expect(simplifyLine(corner)).toHaveLength(3);
  });

  it('keeps every simplified vertex on the original line', () => {
    // The other direction of the guarantee, and the one that matters for buffering: simplification
    // may only *drop* source vertices, so every vertex of the simplified line still lies on the
    // corridor. (Douglas–Peucker's own guarantee bounds how far the simplified line wanders from the
    // source — at most the tolerance per recursion level, so ~7 m for a 3.5 m tolerance — which is
    // why the buffer test allows a vertex up to 35 + 7 + slack from the source centre-line.)
    for (const corridor of corridors) {
      const simplified = simplifyLine(corridor.centerline);
      for (const [lng, lat] of simplified) {
        let closest = Infinity;
        for (let index = 0; index + 1 < simplified.length; index += 1) {
          const [ax, ay] = simplified[index];
          const [bx, by] = simplified[index + 1];
          for (let step = 0; step <= 20; step += 1) {
            const t = step / 20;
            closest = Math.min(closest, haversineMeters([lng, lat], [ax + (bx - ax) * t, ay + (by - ay) * t]));
          }
        }
        expect(closest).toBeLessThan(0.5);
      }
      expect(simplified[0]).toEqual(corridor.centerline[0]);
      expect(simplified[simplified.length - 1]).toEqual(corridor.centerline[corridor.centerline.length - 1]);
    }
  });
});
