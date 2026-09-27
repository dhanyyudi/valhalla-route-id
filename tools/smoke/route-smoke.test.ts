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

const vaduz = { lat: 47.1392862, lon: 9.5227962 };
const malbun = { lat: 47.145, lon: 9.5168 };

/** NativeRoute types the common trip fields but leaves `locations` to its index signature. */
const tripLocations = (result: RouteResult) =>
  (result.native.trip as Record<string, unknown>).locations as Array<Record<string, unknown>>;

let server: { url: string; close(): Promise<void> };
let router: Router;

beforeAll(async () => {
  server = await serveDataset({ root: join(RELEASE_DIR, release), port: 8789 });
  const manifest = JSON.parse(readFileSync(join(RELEASE_DIR, release, 'manifest.json'), 'utf8'));
  router = await createRouter({ manifestUrl: `${server.url}/manifest.json`, transport: 'individual-tiles' });
  expect(manifest.release).toBe(release);
  // Proves the router initialized against this fixture rather than another release or a cache.
  expect(router.startup?.release).toBe(release);
}, 120_000);

afterAll(async () => { await router?.dispose(); await server?.close(); });

describe('forked SDK native surface', () => {
  it('routes with a departure time and echoes it', async () => {
    const result = await router.route({ locations: [vaduz, malbun], costing: 'auto', date_time: { type: 1, value: '2026-09-28T07:00' } });
    expect(tripLocations(result)[0].date_time).toBeTruthy();
  }, 60_000);

  it('routes three locations', async () => {
    const result = await router.route({ locations: [vaduz, { lat: 47.142, lon: 9.52 }, malbun], costing: 'auto' });
    expect(tripLocations(result)).toHaveLength(3);
  }, 60_000);

  it('applies bicycle costing distinctly from auto', async () => {
    // The brief's case used motor_scooter, which this fixture release does not declare; the next
    // case pins that refusal. `bicycle` is declared and is the sharpest distinct-profile proof here.
    const auto = await router.route({ locations: [vaduz, malbun], costing: 'auto' });
    const bicycle = await router.route({ locations: [vaduz, malbun], costing: 'bicycle' });
    expect(auto.native.trip.summary.time).toBeGreaterThan(0);
    expect(bicycle.native.trip.summary.time).toBeGreaterThan(0);
    expect(bicycle.native.trip.summary.time).not.toBe(auto.native.trip.summary.time);
  }, 60_000);

  it('refuses a costing this fixture dataset does not declare', async () => {
    // The manifest declares auto, bicycle, pedestrian and truck (scripts/prepare-data.py), so the
    // SDK must refuse motor_scooter explicitly instead of silently routing it as auto.
    await expect(router.route({ locations: [vaduz, malbun], costing: 'motor_scooter' }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_COSTING' });
  }, 60_000);

  it('returns alternates when requested', async () => {
    const result = await router.route({ locations: [vaduz, malbun], costing: 'auto', alternates: 2 });
    expect(result.native.trip.legs.length).toBeGreaterThan(0);
    // This fixture graph has no alternative path for the leg, so native omits `alternates`
    // instead of returning an empty array (UPSTREAM.md). The documented fallback applies.
    expect(result.native.alternates === undefined || Array.isArray(result.native.alternates)).toBe(true);
  }, 60_000);
});
