import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
/** Where each run's numbers are written so the report quotes a measurement, not a recollection. */
const EVIDENCE_JAKARTA = path.join('.superpowers', 'docs', 'reports', 'gage-e2e-jakarta.json');
const EVIDENCE_SUDIRMAN = path.join('.superpowers', 'docs', 'reports', 'gage-e2e-sudirman.json');

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

/** The pair whose exclusion is visible: a 4.4 km hop west-to-east across Jl. Sudirman. */
const SUDIRMAN_WEST = '-6.20850, 106.81200';
const SUDIRMAN_EAST = '-6.20850, 106.83200';

/**
 * One restricted run and its Nonaktif control over the given pair.
 *
 * @param page - The browser page.
 * @param testInfo - Used for the per-run screenshots.
 * @param points - The two stops, as the paste box takes them.
 * @param evidenceFile - Where this run's numbers are written.
 * @param label - Names the run in the log and in the evidence.
 * @returns Both runs' readouts and whether their geometries matched.
 */
async function restrictedThenControl(
  page: import('@playwright/test').Page,
  testInfo: import('@playwright/test').TestInfo,
  points: [string, string],
  evidenceFile: string,
  label: string,
) {
  testInfo.setTimeout(900_000);

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  const map = page.getByTestId('map');
  await expect(map).toHaveAttribute('data-map-ready', 'true', { timeout: 120_000 });
  await expect(page.getByTestId('gage-block')).toBeVisible();
  // The corridor layer is drawn with the basemap style; its ring count is the page's own proof that
  // the layer is on the map (a WebGL canvas cannot be queried from the test). The exact count is
  // pinned by the builder unit test; here it only has to be a drawn, non-empty layer.
  await expect(map).toHaveAttribute('data-gage-rings', /^[1-9]\d*$/, { timeout: 30_000 });

  for (const point of points) {
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
  // The estimate is live before the route runs: the panel already says what the request will carry.
  await expect(page.getByTestId('gage-request')).toContainText('exclude_polygons');

  await route(page, `${label}-restricted`);
  const restricted = await readRun(page, `${label}-restricted`);

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

  await page.screenshot({ path: testInfo.outputPath(`${label}-restricted.png`) });
  // What the run actually sent, beside the estimate — the two can differ by design.
  await expect(page.getByTestId('gage-sent')).toContainText('Dikirim pada rute terakhir');
  console.log(`E2E_RESULT ${JSON.stringify(restricted)}`);

  // ── The control run: same scenario, constraint off. ────────────────────────────────────────────
  await page.getByTestId('parity-off').click();
  await expect(page.getByTestId('gage-status')).toContainText('Tidak berlaku');
  await expect(page.getByTestId('gage-request')).toContainText('tidak membawa exclude_polygons');
  await route(page, `${label}-nonaktif`);
  const control = await readRun(page, `${label}-nonaktif`);

  expect(control.excludePolygons).toBe(0);
  expect(control.request.exclude_polygons).toBeUndefined();
  await expect(page.getByTestId('gage-sent')).toHaveCount(0);
  expect(control.gageActive).toBe('false');
  expect(control.distance).toMatch(/km$/);
  await page.screenshot({ path: testInfo.outputPath(`${label}-nonaktif.png`) });
  console.log(`E2E_RESULT ${JSON.stringify(control)}`);

  const geometryIdentical = restricted.coordinates === control.coordinates
    && restricted.distance === control.distance && restricted.duration === control.duration;
  const evidence = {
    baseUrl: BASE_URL,
    pair: points,
    departure: DEPARTURE,
    restrictedParity: RESTRICTED_PARITY,
    restricted,
    control,
    geometryIdentical,
    excursionKm: Number((Number(control.distance.replace(/[^\d.]/g, '')) - Number(restricted.distance.replace(/[^\d.]/g, ''))).toFixed(3)),
    at: new Date().toISOString(),
  };
  console.log(`E2E_COMPARE ${JSON.stringify(evidence)}`);
  mkdirSync(path.dirname(evidenceFile), { recursive: true });
  writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  return { restricted, control, geometryIdentical };
}

test('ganjil-genap: restricted at 07:00 WIB on the long Jakarta pair, then the Nonaktif control', async ({ page }, testInfo) => {
  test.setTimeout(900_000);
  const { restricted, control, geometryIdentical } = await restrictedThenControl(
    page, testInfo, [JAKARTA, BANDUNG_LIKE], EVIDENCE_JAKARTA, 'jakarta',
  );
  // The required pair. Both runs are reported exactly as measured, including the case where they
  // come back byte-identical: the request carries exclude_polygons, the panel says so, and the
  // crossing report is shown either way.
  expect(restricted.gageStatus).toContain('Kena ganjil-genap');
  expect(control.request.exclude_polygons).toBeUndefined();
  console.log(`E2E_JAKARTA identical=${geometryIdentical} restricted=${restricted.distance} control=${control.distance} ` +
    `crossings: "${restricted.crossing}"`);
});

test('ganjil-genap: the Sudirman pair shows what the browser can and cannot prove', async ({ page }, testInfo) => {
  testInfo.setTimeout(900_000);
  const { restricted, control, geometryIdentical } = await restrictedThenControl(
    page, testInfo, [SUDIRMAN_WEST, SUDIRMAN_EAST], EVIDENCE_SUDIRMAN, 'sudirman',
  );

  // Stable facts, asserted: the restriction is evaluated, the request carries a ring whose
  // coordinates are longitude-first and inside Jakarta, the constraint-off control carries none, and
  // the crossing report is shown in both runs.
  expect(restricted.gageStatus).toContain('Kena ganjil-genap');
  expect(restricted.excludePolygons).toBeGreaterThan(0);
  expect(control.request.exclude_polygons).toBeUndefined();
  expect(restricted.crossing).not.toBe('');
  expect(control.crossing).not.toBe('');

  // What this pair cannot prove, measured rather than asserted: repeating the *identical* request in
  // one session makes the browser runtime answer with different routes, so a single
  // restricted-versus-control pair cannot attribute a difference to the exclusion. The three runs
  // below are that measurement — same scenario, same request, three answers — and the Node adapter on
  // the same release and the same WASM binary answers 4.695 km for the excluded request every time
  // (see tools/smoke/gage-engine.test.ts, where the exclusion itself is proven to work).
  const outcomes: string[] = [];
  for (let index = 1; index <= 3; index += 1) {
    await route(page, `sudirman-repeat-${index}`);
    const repeat = await readRun(page, `sudirman-repeat-${index}`);
    outcomes.push(`${repeat.distance}/${repeat.coordinates}`);
    // The status bar keeps the previous value until the next result lands, so wait for the route
    // button to come back before the next click reads it.
    await page.waitForTimeout(1_500);
  }
  const distinct = [...new Set(outcomes)];
  console.log(`E2E_SUDIRMAN identical=${geometryIdentical} restricted=${restricted.distance} control=${control.distance} ` +
    `repeats=${JSON.stringify(distinct)} restrictedCrossings="${restricted.crossing}" controlCrossings="${control.crossing}"`);

  const evidenceFile = EVIDENCE_SUDIRMAN;
  const existing = JSON.parse(readFileSync(evidenceFile, 'utf8')) as Record<string, unknown>;
  writeFileSync(evidenceFile, `${JSON.stringify({ ...existing, identicalRepeatOutcomes: distinct, identicalRepeatRuns: outcomes }, null, 2)}\n`);
});
