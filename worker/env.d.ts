/// <reference types="@cloudflare/vitest-pool-workers" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Bindings for the Worker under test. `Cloudflare.Env` is the interface
// `wrangler types` would generate from `wrangler.jsonc`; declaring it by hand keeps
// `env` typed identically inside the Worker (worker/index.ts) and inside the tests
// (`env` from `cloudflare:test` is `Cloudflare.Env`), so a binding rename cannot
// drift between the two.
declare namespace Cloudflare {
  interface Env {
    ASSETS: Fetcher;
    GRAPH: R2Bucket;
  }
}
