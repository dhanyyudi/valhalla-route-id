import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Browser acceptance test for the ganjil-genap constraint layer, run against the deployed Worker.
 *
 * Two runs over the same Jakarta pair (see the README's cache-budget measurements: this is the
 * 24.5 km route that reads the four big Jakarta tiles):
 *
 * 1. **restricted** — a weekday 07:00 WIB departure with a plate parity that differs from the date.
 *    The panel must report `restricted`, the request the app actually built must carry
 *    `exclude_polygons`, and the crossing report must appear.
 * 2. **control, Nonaktif** — the same pair with the constraint off. The request must carry no
 *    `exclude_polygons` at all, and the two runs' distance/duration/geometry are compared and
 *    reported whichever way they land.
 *
 * Point it somewhere else with `E2E_BASE_URL` (for example a local `pnpm preview`).
 */
const BASE_URL = process.env.E2E_BASE_URL?.trim() || 'https://valhalla-route-id.gislabs.workers.dev';

/** The README's measured Jakarta pair: 24.5 km, four large tiles. */
const JAKARTA = '-6.18330, 106.78038';
const BANDUNG_LIKE = '-6.19860, 106.87630';

/** Monday 28 September 2026 is day 28 in WIB — an even date, so `Ganjil` must be restricted. */
const DEPARTURE = '2026-09-28T07:00';
const RESTRICTED_PARITY = 'odd';

/** Ceiling for one route; the client also stops a route after 10 minutes. */
const ROUTE_BUDGET_MS = 600_000;
/** Where the run's numbers are written so the report quotes a measurement, not a recollection. */
const EVIDENCE = path.join('.superpowers', 'docs', 'reports', 'gage-e2e.json');

interface RunEvidence {
  label: string;
  gageStatus: string;
  gageReason: string;
  gageRequest: string;
  crossing: string;
  distance: string;
  duration: string;
  coordinates: number;
  gageRings: string;
  gageActive: string;
  request: { exclude_polygons?: unknown; costing?: unknown; date_time?: unknown };
  excludePolygons: number;
  excludeRings: number;
}

/** Press "Hitung rute" and wait for the status bar to carry a distance or the panel to report one. */
async function route(page: import('@playwright/test').Page, label: string): Promise<void> {
  const started = Date.now();
  await page.getByTestId('run').click();
  const deadline = Date.now() + ROUTE_BUDGET_MS;
  while (Date.now() < deadline) {
    if (await page.getByTestId('panel-error').isVisible().catch(() => false)) {
      const failure = (await page.getByTestId('panel-error').textContent()) ?? '';
      throw new Error(`${label}: the app reported a routing failure: ${failure}`);
    }
    const distance = ((await page.getByTestId('status-distance').textContent()) ?? '').trim();
    if (distance !== '—' && distance !== '') {
      console.log(`E2E_ROUTE ${label} ${Math.round((Date.now() - started) / 1000)}s ${distance}`);
      return;
    }
    await page.waitForTimeout(2_000);
  }
  throw new Error(`${label}: no route after ${Math.round((Date.now() - started) / 1000)} s`);
}

async function readRun(page: import('@playwright/test').Page, label: string): Promise<RunEvidence> {
  const text = async (testId: string) => ((await page.getByTestId(testId).textContent()) ?? '').trim();
  const request = await page.evaluate(() => (window as unknown as { valhallaLastRequest?: () => unknown }).valhallaLastRequest?.() ?? null) as RunEvidence['request'] | null;
  const container = page.getByTestId('map');
  const polygons = (request?.exclude_polygons ?? []) as number[][][];
  return {
    label,
    gageStatus: await text('gage-status'),
    gageReason: await text('gage-reason'),
    gageRequest: await text('gage-request'),
    crossing: await text('gage-crossing'),
    distance: await text('status-distance'),
    duration: await text('status-duration'),
    coordinates: Number(await container.getAttribute('data-route-coordinates')),
    gageRings: (await container.getAttribute('data-gage-rings')) ?? '',
    gageActive: (await container.getAttribute('data-gage-active')) ?? '',
    request: request ?? {},
    excludePolygons: Array.isArray(request?.exclude_polygons) ? (request!.exclude_polygons as unknown[]).length : 0,
    excludeRings: polygons.reduce((sum, ring) => sum + (Array.isArray(ring) ? ring.length : 0), 0),
  };
}

test('ganjil-genap: restricted at 07:00 WIB, then the Nonaktif control', async ({ page }, testInfo) => {
  test.setTimeout(900_000);

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  const map = page.getByTestId('map');
  await expect(map).toHaveAttribute('data-map-ready', 'true', { timeout: 120_000 });
  await expect(page.getByTestId('gage-block')).toBeVisible();
  // The corridor layer is drawn with the basemap style; its ring count is the page's own proof that
  // the layer is on the map (a WebGL canvas cannot be queried from the test). The exact count is
  // pinned by the builder unit test; here it only has to be a drawn, non-empty layer.
  await expect(map).toHaveAttribute('data-gage-rings', /^[1-9]\d*$/, { timeout: 30_000 });

  for (const point of [JAKARTA, BANDUNG_LIKE]) {
    await page.getByTestId('paste-input').fill(point);
    await page.getByTestId('paste-add').click();
  }
  await expect(page.getByTestId('remove-waypoint-1')).toBeVisible();

  // Weekday 07:00 WIB, plate parity that differs from the date's parity.
  await page.getByTestId('time-depart').click();
  await page.getByTestId('departure-input').fill(DEPARTURE);
  await page.getByTestId(`parity-${RESTRICTED_PARITY}`).click();
  await expect(page.getByTestId(`parity-${RESTRICTED_PARITY}`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('gage-status')).toContainText('Kena ganjil-genap');
  // The plan is live before the route runs: the panel already says what the request will carry.
  await expect(page.getByTestId('gage-request')).toContainText('exclude_polygons');

  await route(page, 'restricted');
  const restricted = await readRun(page, 'restricted');

  // The request the app actually handed the SDK — read from the app, not reconstructed here.
  expect(restricted.excludePolygons).toBeGreaterThan(0);
  expect(restricted.excludeRings).toBeGreaterThanOrEqual(4);
  expect(restricted.gageActive).toBe('true');
  // Longitude first: every ring vertex must sit in Jakarta's longitude band, not its latitude's.
  const vertices = ((restricted.request.exclude_polygons ?? []) as number[][][]).flat();
  expect(vertices.every(([lng, lat]) => lng > 106.6 && lng < 107.0 && lat > -6.4 && lat < -6.0)).toBe(true);
  // The crossing report is the honest half: it must be shown, and it must name corridors or say
  // plainly that none are crossed.
  expect(restricted.crossing).not.toBe('');
  expect(restricted.crossing).toMatch(/ganjil-genap/);
  expect(restricted.distance).toMatch(/km$/);

  await page.screenshot({ path: testInfo.outputPath('ganjil-genap-restricted.png') });
  console.log(`E2E_RESULT ${JSON.stringify(restricted)}`);

  // ── The control run: same scenario, constraint off. ────────────────────────────────────────────
  await page.getByTestId('parity-off').click();
  await expect(page.getByTestId('gage-status')).toContainText('Tidak berlaku');
  await expect(page.getByTestId('gage-request')).toContainText('tidak membawa exclude_polygons');
  await route(page, 'nonaktif');
  const control = await readRun(page, 'nonaktif');

  expect(control.excludePolygons).toBe(0);
  expect(control.request.exclude_polygons).toBeUndefined();
  expect(control.gageActive).toBe('false');
  expect(control.distance).toMatch(/km$/);
  await page.screenshot({ path: testInfo.outputPath('ganjil-genap-nonaktif.png') });
  console.log(`E2E_RESULT ${JSON.stringify(control)}`);

  const geometryIdentical = restricted.coordinates === control.coordinates
    && restricted.distance === control.distance && restricted.duration === control.duration;
  const evidence = {
    baseUrl: BASE_URL,
    departure: DEPARTURE,
    restrictedParity: RESTRICTED_PARITY,
    restricted,
    control,
    geometryIdentical,
    excursionKm: Number((Number(control.distance.replace(/[^\d.]/g, '')) - Number(restricted.distance.replace(/[^\d.]/g, ''))).toFixed(3)),
    at: new Date().toISOString(),
  };
  console.log(`E2E_COMPARE ${JSON.stringify(evidence)}`);
  mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
});
