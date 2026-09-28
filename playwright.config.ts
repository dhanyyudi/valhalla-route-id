import { defineConfig } from '@playwright/test';

/**
 * Browser selection.
 *
 * Default: Playwright's own Chromium. `E2E_CHANNEL=chrome` drives an installed Google Chrome
 * instead, which is what the machine that ran the Task 11 acceptance test used (the download of
 * the bundled build stalled there), and `E2E_ARGS` adds launch flags.
 *
 * Branded Chrome launched headless loses its WebGL context about a second after the map is
 * created. MapLibre then destroys the style, aborts the in-flight basemap request and never fires
 * `load`, so the route layer has nothing to draw on. ANGLE's SwiftShader backend is stable, and
 * Playwright's bundled Chromium already runs that way, so only the branded channel needs the flags.
 */
const channel = process.env.E2E_CHANNEL || undefined;
const args = process.env.E2E_ARGS?.split(' ').filter(Boolean)
  ?? (channel ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : []);

// The browser acceptance test routes Jakarta → Bandung against the deployed Worker. A cold cache
// has to read ~200 MB of graph ranges out of the 2 GB archive, and the 48.4 MB Jakarta tile was
// measured at 79–101 s on a congested link, so the default 30 s expectation budget is far too
// small: the spec sets its own per-assertion budgets, and this is the ceiling for the whole test.
export default defineConfig({
  testDir: './e2e',
  timeout: 900_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  // Artifacts (screenshots, traces) are evidence, not source: they land under the gitignored
  // .superpowers/ tree rather than in a tracked test-results/ directory.
  outputDir: '.superpowers/e2e-artifacts',
  use: {
    headless: true,
    viewport: { width: 1440, height: 900 },
    channel,
    launchOptions: { args },
  },
});
