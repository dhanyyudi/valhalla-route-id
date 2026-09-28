import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Browser acceptance test for Task 11, run against the deployed Worker.
 *
 * One test, one route: paste Jakarta and Bandung, pick motorcycle, depart at 07:00, press
 * "Hitung rute", and require that the status bar reports a distance and a duration and that the
 * map's route source actually holds decoded geometry.
 *
 * Point it somewhere else with E2E_BASE_URL (for example a local `pnpm preview`).
 */
const BASE_URL = process.env.E2E_BASE_URL ?? 'https://valhalla-route-id.gislabs.workers.dev';
const JAKARTA = '-6.1754, 106.8272';
const BANDUNG = '-6.9175, 107.6191';
const RELEASE = 'indonesia-260926-eab7ae90e4197185';
/** Ceiling for the route itself; the client also stops a route after 10 minutes. */
const ROUTE_BUDGET_MS = 780_000;
/** Where the run's numbers are written so the report quotes a measurement, not a recollection. */
const EVIDENCE = path.join('.superpowers', 'sdd', '2026-09-27-valhalla-route-id-foundation', 'task-11-e2e.json');

test('motorcycle Jakarta → Bandung departing 07:00 draws a route', async ({ page }, testInfo) => {
  test.setTimeout(900_000);
  const phases: string[] = [];

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  const map = page.getByTestId('map');
  await expect(map).toHaveAttribute('data-map-ready', 'true', { timeout: 120_000 });

  // Two waypoints through the paste box: the same control a user has for a Google Maps link.
  for (const point of [JAKARTA, BANDUNG]) {
    await page.getByTestId('paste-input').fill(point);
    await page.getByTestId('paste-add').click();
  }
  await expect(page.getByTestId('remove-waypoint-1')).toBeVisible();

  await page.getByTestId('profile-motorcycle').click();
  await expect(page.getByTestId('profile-motorcycle')).toHaveAttribute('aria-pressed', 'true');

  // 07:00 is a preset; it also switches the control into "depart at" mode.
  await page.getByTestId('preset-7').click();
  await expect(page.getByTestId('time-depart')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('departure-input')).toHaveValue(/T07:00$/);

  const started = Date.now();
  await page.getByTestId('run').click();
  await expect(page.getByTestId('progress')).toBeVisible({ timeout: 30_000 });
  // A route that reads hundreds of megabytes must stay interruptible while it runs.
  await expect(page.getByTestId('cancel')).toBeVisible({ timeout: 30_000 });

  let outcome: 'done' | 'error' | 'timeout' = 'timeout';
  let failure = '';
  const deadline = Date.now() + ROUTE_BUDGET_MS;
  while (Date.now() < deadline) {
    if (await page.getByTestId('panel-error').isVisible().catch(() => false)) {
      outcome = 'error';
      failure = (await page.getByTestId('panel-error').textContent()) ?? '';
      break;
    }
    const distance = (await page.getByTestId('status-distance').textContent()) ?? '';
    if (distance.trim() !== '—' && distance.trim() !== '') {
      outcome = 'done';
      break;
    }
    const progress = await page.getByTestId('progress').textContent().catch(() => null);
    if (progress && phases.at(-1) !== progress.replace(/\s*·\s*\d+ (j|mnt|dtk).*$/, '')) phases.push(progress);
    await page.waitForTimeout(2_000);
  }
  const wallMs = Date.now() - started;
  if (outcome === 'error') throw new Error(`The app reported a routing failure: ${failure}`);
  if (outcome !== 'done') throw new Error(`No route after ${Math.round(wallMs / 1000)} s; progress seen: ${phases.join(' | ')}`);

  const readout = async (testId: string) => ((await page.getByTestId(testId).textContent()) ?? '').trim();
  const distance = await readout('status-distance');
  const duration = await readout('status-duration');
  const release = await readout('status-release');
  const bytes = await readout('status-bytes');
  const geometry = await readout('status-geometry');
  const simulated = await readout('status-time');
  const coordinates = Number(await map.getAttribute('data-route-coordinates'));
  const firstInstruction = ((await page.getByTestId('instructions').locator('li').first().textContent()) ?? '').trim();

  expect(distance).toMatch(/km$/);
  expect(duration).toMatch(/dtk/);
  expect(release).toBe(RELEASE);
  expect(bytes).not.toBe('—');
  expect(coordinates).toBeGreaterThan(1_000);
  // The route layer is drawn from the same call that fills this attribute, and the status bar
  // counts the coordinates it decoded; a WebGL canvas cannot be queried from the page.
  expect(Number(geometry.replace(/\D/g, ''))).toBe(coordinates);
  // Instructions come back in English because the shipped WASM carries only the en-US locale.
  expect(firstInstruction).toMatch(/[A-Za-z]{3,}/);
  expect(simulated).toContain('2026-');

  await page.screenshot({ path: testInfo.outputPath('route.png'), fullPage: false });
  const evidence = { baseUrl: BASE_URL, wallMs, wallSeconds: Number((wallMs / 1000).toFixed(1)), distance, duration, release, bytes, geometry, coordinates, simulated, firstInstruction, phases, at: new Date().toISOString() };
  console.log(`E2E_RESULT ${JSON.stringify(evidence)}`);
  mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
});
