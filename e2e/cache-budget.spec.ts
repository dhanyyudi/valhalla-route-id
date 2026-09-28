import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Decoded-tile cache measurement, run against a deployed build.
 *
 * One route, one profile, one run, and every number the diagnosis needs: wall time from clicking
 * "Hitung rute" to the result appearing, the graph bytes the status bar reports,
 * `router.diagnostics()` (loader counters, decoded-cache hits, WASM heap high-water) and the tile
 * ids the progress line reveals. The same spec runs before and after a cache change, so the two
 * runs are the same measurement rather than two different ones.
 *
 * `E2E_PROFILE` selects the profile (default `auto`), `E2E_LABEL` names the evidence file, and
 * `E2E_DIAGNOSTICS=0` skips the optional `window.valhallaDiagnostics()` hook for a build that does
 * not carry it — a missing hook is recorded as `null`, never as a failure.
 */
const BASE_URL = process.env.E2E_BASE_URL?.trim() || 'https://valhalla-route-id.gislabs.workers.dev';
/** The 24.5 km Jakarta pair the diagnosis quotes (lat/lon, the only format the paste box takes). */
const START = process.env.E2E_START?.trim() || '-6.18330, 106.78038';
const END = process.env.E2E_END?.trim() || '-6.19860, 106.87630';
const PROFILE = process.env.E2E_PROFILE?.trim() || 'auto';
const LABEL = process.env.E2E_LABEL?.trim() || `${PROFILE}-run`;
/**
 * The application stops a route after 600 s (`ROUTE_TIMEOUT_MS` in `src/router/client.ts`), so the
 * poll budget is a little longer: the run must observe that timeout and record it, not be killed
 * by Playwright before the app reports.
 */
const ROUTE_BUDGET_MS = 700_000;
/** Evidence lands under the gitignored `.superpowers/` tree, next to the other run artifacts. */
const EVIDENCE = path.join('.superpowers', 'measurements', `${LABEL}.json`);

interface ObservedRange {
  status: number;
  contentRange: string | null;
  contentLength: number;
  cfCacheStatus: string | null;
}

test(`decoded-tile cache measurement: ${PROFILE} ${START} → ${END}`, async ({ page }, testInfo) => {
  test.setTimeout(900_000);
  const phases: string[] = [];
  const ranges: ObservedRange[] = [];

  page.on('response', async response => {
    if (!response.url().includes('/datasets/')) return;
    const headers = await response.allHeaders().catch(() => ({}) as Record<string, string>);
    const length = Number(headers['content-length'] ?? 0);
    ranges.push({
      status: response.status(),
      contentRange: headers['content-range'] ?? null,
      contentLength: Number.isFinite(length) ? length : 0,
      cfCacheStatus: headers['cf-cache-status'] ?? null,
    });
  });

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('map')).toHaveAttribute('data-map-ready', 'true', { timeout: 120_000 });

  for (const point of [START, END]) {
    await page.getByTestId('paste-input').fill(point);
    await page.getByTestId('paste-add').click();
  }
  await expect(page.getByTestId('remove-waypoint-1')).toBeVisible();
  await page.getByTestId(`profile-${PROFILE}`).click();
  await expect(page.getByTestId(`profile-${PROFILE}`)).toHaveAttribute('aria-pressed', 'true');

  const started = Date.now();
  await page.getByTestId('run').click();
  await expect(page.getByTestId('progress')).toBeVisible({ timeout: 30_000 });

  let outcome: 'done' | 'error' | 'timeout' = 'timeout';
  let failure = '';
  const deadline = started + ROUTE_BUDGET_MS;
  while (Date.now() < deadline) {
    if (await page.getByTestId('panel-error').isVisible().catch(() => false)) {
      outcome = 'error';
      failure = ((await page.getByTestId('panel-error').textContent()) ?? '').trim();
      break;
    }
    const distance = ((await page.getByTestId('status-distance').textContent()) ?? '').trim();
    if (distance !== '' && distance !== '—') {
      outcome = 'done';
      break;
    }
    const progress = await page.getByTestId('progress').textContent().catch(() => null);
    // The elapsed counter ticks every second; keep the phase and tile id only.
    if (progress && phases.at(-1) !== progress.replace(/\s*·\s*\d+ (j|mnt|dtk).*$/, '')) {
      phases.push(progress.replace(/\s*·\s*\d+ (j|mnt|dtk).*$/, ''));
    }
    await page.waitForTimeout(500);
  }
  const wallMs = Date.now() - started;
  // Let any trailing range request settle before the counters are read.
  await page.waitForTimeout(2_000);

  const readout = async (testId: string) => ((await page.getByTestId(testId).textContent()) ?? '').trim();
  const diagnostics = process.env.E2E_DIAGNOSTICS === '0' ? null : await page.evaluate(async () => {
    const hook = (globalThis as { valhallaDiagnostics?: () => Promise<unknown> }).valhallaDiagnostics;
    if (typeof hook !== 'function') return null;
    const sample = await hook() as {
      startup: Record<string, unknown> | null;
      diagnostics: {
        metrics: Record<string, number>;
        trace: Array<{ tileId?: string; size: string; elapsedMs: number; http: Record<string, string | null> }>;
        native: Record<string, number>;
        resourceTiming: Array<{ transferSize: number | null; decodedBodySize: number | null; durationMs: number }>;
      };
    };
    const reads = sample.diagnostics.trace.filter(entry => entry.tileId !== undefined);
    const perTile = new Map<string, number>();
    for (const entry of reads) perTile.set(entry.tileId!, (perTile.get(entry.tileId!) ?? 0) + 1);
    const resourceTiming = sample.diagnostics.resourceTiming.filter(entry => entry.decodedBodySize !== null);
    return {
      startup: sample.startup,
      metrics: sample.diagnostics.metrics,
      native: sample.diagnostics.native,
      tileReads: reads.length,
      distinctTiles: perTile.size,
      tileBytes: reads.reduce((total, entry) => total + Number(entry.size), 0),
      repeats: [...perTile.entries()].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1])
        .map(([tileId, count]) => ({ tileId, count })),
      tileIdsInOrder: reads.map(entry => entry.tileId!),
      slowestReads: [...reads].sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, 12)
        .map(entry => ({ tileId: entry.tileId, size: entry.size, elapsedMs: Math.round(entry.elapsedMs), age: entry.http.age ?? null, cfCacheStatus: entry.http['cf-cache-status'] ?? null })),
      resourceTiming: {
        entries: resourceTiming.length,
        transferBytes: resourceTiming.reduce((total, entry) => total + (entry.transferSize ?? 0), 0),
        decodedBytes: resourceTiming.reduce((total, entry) => total + (entry.decodedBodySize ?? 0), 0),
        maxDurationMs: Math.round(resourceTiming.reduce((max, entry) => Math.max(max, entry.durationMs), 0)),
      },
    };
  }).catch(error => ({ hookError: String(error) }));

  const distinctRanges = new Set(ranges.map(range => range.contentRange ?? `${range.status}:${range.contentLength}`));
  const evidence = {
    label: LABEL, baseUrl: BASE_URL, profile: PROFILE, start: START, end: END,
    outcome, failure, wallMs, wallSeconds: Number((wallMs / 1000).toFixed(1)),
    distance: await readout('status-distance'),
    duration: await readout('status-duration'),
    release: await readout('status-release'),
    reportedBytes: await readout('status-bytes'),
    geometry: await readout('status-geometry'),
    coordinates: Number(await page.getAttribute('[data-testid="map"]', 'data-route-coordinates')),
    phases,
    diagnostics,
    network: {
      responses: ranges.length,
      bytes: ranges.reduce((total, range) => total + range.contentLength, 0),
      distinctRanges: distinctRanges.size,
      repeatedRanges: ranges.length - distinctRanges.size,
      statuses: ranges.reduce<Record<string, number>>((counts, range) => ({ ...counts, [range.status]: (counts[range.status] ?? 0) + 1 }), {}),
      cfCacheStatuses: ranges.reduce<Record<string, number>>((counts, range) => ({ ...counts, [range.cfCacheStatus ?? 'none']: (counts[range.cfCacheStatus ?? 'none'] ?? 0) + 1 }), {}),
    },
    at: new Date().toISOString(),
  };
  console.log(`E2E_MEASUREMENT ${JSON.stringify(evidence)}`);
  mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
  await page.screenshot({ path: testInfo.outputPath(`${LABEL}.png`) });

  // The measurement is the deliverable: an app-reported failure is recorded, not thrown, but a run
  // that never produced a route still fails the spec so the caller sees it.
  expect(outcome, `route outcome was ${outcome}${failure ? `: ${failure}` : ''}`).not.toBe('timeout');
});
