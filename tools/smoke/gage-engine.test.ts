// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRouter, type RouteResult, type Router } from 'valhalla-server/node';
import { serveDataset } from '../serve-dataset.mjs';
import { encodeExcludePolygons, selectCorridorsForRoute, type CorridorPolygons } from '../../src/core/gage-geometry';
import { findCorridorCrossings } from '../../src/core/gage-crossing';
import { decodePolyline6 } from '../../src/map/route-layer';

/**
 * Ganjil-genap corridor exclusion against the real engine.
 *
 * This is the claim the whole feature rests on and the one a unit test cannot make: that the rings
 * `pnpm build:gage` produces, encoded the way `src/core/request-builder.ts` encodes them, make
 * Valhalla actually avoid those streets. It runs the Indonesia release out of `public/datasets/`
 * (the same archive the deployed app reads) through the Node adapter, so a change to the ring
 * geometry, the encoder or the packer that quietly stops working fails here.
 *
 * It needs the 2 GB Indonesia release on disk and a few hundred MB of heap, so it skips itself —
 * loudly, on stdout — when the release is absent rather than failing a laptop that only has the
 * small verification fixture.
 */
const RELEASE = 'indonesia-260926-eab7ae90e4197185';
const releaseDir = join('public', 'datasets', RELEASE);
const available = existsSync(join(releaseDir, 'manifest.json'));

/** The Jakarta pair the README measures; it crosses nine of the 25 corridors. */
const START = { lat: -6.1833, lon: 106.78038 };
const END = { lat: -6.1986, lon: 106.8763 };
/** The deployment's `service_limits.max_exclude_polygons_length`, in metres. */
const SERVICE_LIMIT_METERS = 10_000;

const corridors = (JSON.parse(readFileSync(join('src', 'data', 'gage-polygons.json'), 'utf8')) as {
  corridors: CorridorPolygons[];
  bufferMeters: number;
}).corridors;
const bufferMeters = 35;

/** Every leg's geometry, concatenated in travel order. */
const coordinatesOf = (result: RouteResult) => result.native.trip.legs.flatMap(leg => decodePolyline6(leg.shape));

/**
 * Its own port, deliberately: the other two smoke suites read `VALHALLA_TEST_PORT` (8795 is what the
 * README's gate command passes), and binding the same port from a third suite in one `vitest run`
 * fails with EADDRINUSE. Override with `VALHALLA_GAGE_PORT`.
 */
const port = Number(process.env.VALHALLA_GAGE_PORT ?? 8791);

let server: { url: string; close(): Promise<void> } | undefined;
let router: Router | undefined;

beforeAll(async () => {
  if (!available) return;
  server = await serveDataset({ root: releaseDir, port });
  router = await createRouter({
    manifestUrl: `${server.url}/manifest.json`,
    transport: 'individual-tiles',
    // The dataset's largest tile is 48,442,160 B; the adapter's 32 MiB default refuses to start.
    memoryBudgetBytes: 384 * 1048576,
    wasmMemory: { initialMiB: 128, maximumMiB: 1024 },
  });
}, 180_000);

afterAll(async () => { await router?.dispose(); await server?.close(); });

describe.skipIf(!available)('corridor exclusion on the real engine', () => {
  it('sends rings the route runs through, and the engine takes a different path around them', async () => {
    const baseline = await router!.route({ locations: [START, END], costing: 'auto' });
    const baselineGeometry = coordinatesOf(baseline);
    const baselineCrossings = findCorridorCrossings(baselineGeometry, corridors);
    // The premise of the test: this pair really does cross ganjil-genap corridors.
    expect(baselineCrossings.count).toBeGreaterThan(0);

    const selection = selectCorridorsForRoute({
      route: baselineGeometry,
      corridors,
      bufferMeters,
      crossed: baselineCrossings.corridors,
    });
    expect(selection.rings.length).toBeGreaterThan(0);
    expect(selection.perimeterMeters).toBeLessThan(SERVICE_LIMIT_METERS);
    // Whatever the packer chose must be a corridor the baseline route actually runs through, not one
    // it passes beside: that mistake is what made an earlier deployed build route identically with
    // and without the constraint.
    const crossedIds = new Set(baselineCrossings.corridors.map(corridor => corridor.id));
    const besideTheRoute = selection.rings.filter(entry => !crossedIds.has(entry.corridor.id));
    expect(besideTheRoute.map(entry => `${entry.corridor.id}:${entry.corridor.name}`)).toEqual([]);

    const avoided = await router!.route({
      locations: [START, END],
      costing: 'auto',
      exclude_polygons: encodeExcludePolygons(selection.rings),
    });
    const avoidedGeometry = coordinatesOf(avoided);
    const avoidedCrossings = findCorridorCrossings(avoidedGeometry, corridors);

    // The engine must not have ignored the rings: the geometry has to change, and the corridors it
    // was asked to avoid must no longer be crossed by the returned route.
    expect(avoidedGeometry).not.toEqual(baselineGeometry);
    const avoidedIds = new Set(avoidedCrossings.corridors.map(corridor => corridor.id));
    const stillCrossed = selection.rings.map(entry => entry.corridor.id).filter(id => avoidedIds.has(id));
    expect(stillCrossed).toEqual([]);
    console.log(`GAGE_ENGINE baseline=${baseline.native.trip.summary.length} km/${baselineCrossings.count} corridors ` +
      `avoided=${avoided.native.trip.summary.length} km/${avoidedCrossings.count} corridors ` +
      `ringPerimeter=${selection.perimeterMeters} m`);
  }, 600_000);
});

if (!available) console.log(`skipping the corridor-exclusion engine test: ${releaseDir} is not on disk`);
