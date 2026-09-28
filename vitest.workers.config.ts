import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// @cloudflare/vitest-pool-workers 0.22.0 replaced `defineWorkersConfig()` with the
// `cloudflareTest()` Vite plugin, so the pool is configured through `plugins` rather
// than `test.poolOptions.workers`. The `wrangler.configPath` option is unchanged and
// is what binds `env.GRAPH` and `env.ASSETS` for the tests.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  test: {
    include: ['worker/**/*.test.ts'],
  },
});
