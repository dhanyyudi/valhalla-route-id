// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRouter, type RouteResult, type Router } from 'valhalla-server/node';
import { serveDataset } from '../serve-dataset.mjs';

const RELEASE_DIR = join('public', 'datasets');
// scripts/prepare-data.py names the regional release `liechtenstein-2015-v1-<16 hex>`. Select it by
// shape — never by position — and fail loudly when the fixture was not built and synced back.
const releases = (existsSync(RELEASE_DIR) ? readdirSync(RELEASE_DIR, { withFileTypes: true }) : [])
  .filter(entry => entry.isDirectory() && /^liechtenstein-2015-v1-[0-9a-f]{16}$/.test(entry.name)
    && existsSync(join(RELEASE_DIR, entry.name, 'manifest.json')))
  .map(entry => entry.name);
if (releases.length !== 1)
  throw new Error(`Expected exactly one liechtenstein-2015-v1-* release under ${RELEASE_DIR}, found ${releases.length}. Build it with pnpm run data:region (Docker on the homeserver) and sync public/datasets/ back.`);
const release = releases[0];

// 8790 is also the port `tools/verify/compare.mjs` serves the Indonesia release on, so a corpus
// run held it and this suite failed to bind while a long verification was in flight. Override it
// with VALHALLA_TEST_PORT to run the two side by side (tools/smoke/route-smoke.test.ts uses 8789).
const port = Number(process.env.VALHALLA_TEST_PORT ?? 8790);

const vaduz = { lat: 47.1392862, lon: 9.5227962 };
const malbun = { lat: 47.145, lon: 9.5168 };
/** A third stop between the two towns, so an optimized order has something to reorder. */
const schaanwald = { lat: 47.142, lon: 9.52 };

/** NativeRoute types the route fields; each tool response keeps its own top-level shape. */
const response = (result: RouteResult) => result.native as Record<string, unknown>;
const trip = (result: RouteResult) => result.native.trip as Record<string, unknown>;

let server: { url: string; close(): Promise<void> };
let router: Router;

beforeAll(async () => {
  server = await serveDataset({ root: join(RELEASE_DIR, release), port });
  const manifest = JSON.parse(readFileSync(join(RELEASE_DIR, release, 'manifest.json'), 'utf8'));
  router = await createRouter({ manifestUrl: `${server.url}/manifest.json`, transport: 'individual-tiles' });
  expect(manifest.release).toBe(release);
  // Proves the router initialized against this fixture rather than another release or a cache.
  expect(router.startup?.release).toBe(release);
}, 120_000);

afterAll(async () => { await router?.dispose(); await server?.close(); });

describe('isochrone, optimized route and matrix', () => {
  it('returns isochrone contours as GeoJSON', async () => {
    const result = await router.isochrone({
      locations: [vaduz], costing: 'auto',
      contours: [{ time: 5, color: 'ff0000' }, { time: 10, color: '00ff00' }],
      polygons: true,
    });
    const native = response(result);
    expect(native.type).toBe('FeatureCollection');
    const features = native.features as Array<Record<string, unknown>>;
    expect(Array.isArray(features)).toBe(true);
    expect(features.length).toBeGreaterThan(0);
    // polygons:true yields one filled feature per band, largest band first (native ordering).
    expect(features).toHaveLength(2);
    for (const feature of features) {
      expect(feature.type).toBe('Feature');
      expect((feature.geometry as Record<string, unknown>).type).toBe('Polygon');
      expect((feature.properties as Record<string, unknown>).metric).toBe('time');
    }
    expect(features.map(feature => (feature.properties as Record<string, unknown>).contour)).toEqual([10, 5]);
    expect(result.dataset.release).toBe(release);
    expect(result.diagnostics.routeMs).toBeGreaterThan(0);
  }, 60_000);

  it('returns an optimized visiting order', async () => {
    const result = await router.optimizedRoute({ locations: [vaduz, schaanwald, malbun], costing: 'auto' });
    const locations = trip(result).locations as Array<Record<string, unknown>>;
    const legs = trip(result).legs as Array<Record<string, unknown>>;
    expect(locations).toHaveLength(3);
    // Three stops produce two legs: the tour ends at the last location instead of returning.
    expect(legs).toHaveLength(2);
    expect(((trip(result).summary as Record<string, unknown>).time as number)).toBeGreaterThan(0);
    expect(result.dataset.release).toBe(release);
  }, 60_000);

  it('returns a 2x2 matrix', async () => {
    const result = await router.matrix({ sources: [vaduz, malbun], targets: [vaduz, malbun], costing: 'auto' });
    const matrix = response(result).sources_to_targets as Array<Array<Record<string, unknown>>>;
    expect(matrix).toHaveLength(2);
    expect(matrix[0]).toHaveLength(2);
    for (const row of matrix) for (const pair of row) {
      expect(typeof pair.time).toBe('number');
      expect(pair.time as number).toBeGreaterThanOrEqual(0);
      expect(pair.distance as number).toBeGreaterThanOrEqual(0);
      expect(pair.from_index).toBeTypeOf('number');
      expect(pair.to_index).toBeTypeOf('number');
    }
    // Identical source/target pairs are trivially zero, and a cross pair proves real computation.
    expect(matrix[0][0].time).toBe(0);
    expect(matrix[1][1].distance).toBe(0);
    expect(matrix[0][1].time as number).toBeGreaterThan(0);
    expect(matrix[0][1].distance as number).toBeGreaterThan(0);
    expect(response(result).algorithm).toBe('costmatrix');
    expect(result.dataset.release).toBe(release);
  }, 60_000);

  it('refuses a costing this fixture dataset does not declare for the new tools too', async () => {
    // The release declares auto, bicycle, pedestrian and truck, so the shared engine path must
    // refuse motor_scooter before native routing for every tool, exactly as route() does.
    await expect(router.isochrone({ locations: [vaduz], costing: 'motor_scooter', contours: [{ time: 5 }] }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_COSTING' });
    await expect(router.matrix({ sources: [vaduz], targets: [malbun], costing: 'motor_scooter' }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_COSTING' });
  }, 60_000);
});
