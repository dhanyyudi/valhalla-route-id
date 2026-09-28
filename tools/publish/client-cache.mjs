#!/usr/bin/env node
/**
 * Browser-style immutable cache for a Node client, loaded as a preload module:
 *
 *   node --import ./tools/publish/client-cache.mjs tools/publish/verify-deployed.mjs \
 *     --manifest-url https://<host>/datasets/<release>/manifest.json
 *
 * The `./` is load-bearing: `--import` takes an import specifier, not a path, so a bare
 * `tools/...` is resolved as a package name and fails with ERR_MODULE_NOT_FOUND.
 *
 * Why this exists: the Worker serves every dataset object with
 * `Cache-Control: public, max-age=31536000, immutable` (`worker/index.ts`), and a browser keeps
 * the tile ranges it has already read. The SDK's own loader keeps **no** tile bytes — every
 * access is a fresh request whose body is re-validated against the tile's `sha256`
 * (`packages/valhalla-core/src/loader.ts`) — and a Node client has no HTTP cache at all.
 *
 * That combination is not a rounding error. One Jakarta→Bandung `auto` route on this release
 * issues 4,650 tile reads totalling 89 GiB, but those reads cover only **18 distinct byte
 * ranges** (207 MiB): the two largest Jakarta tiles alone are 48.4 MB and 37.4 MB against a
 * 96 MiB decoded-tile budget, so the engine re-reads them thousands of times. Over a WAN the
 * cacheless client cannot finish inside the SDK host's 300 s maximum — the first uncached tile
 * read (tens of MB) even exceeds the loader's default 10 s per-request timeout. With this cache
 * the same route completes, the origin serves the 18 distinct ranges once, and everything else is
 * a local re-read that the loader still validates by sha256.
 *
 * The cache never changes a response: it stores the status and headers the origin returned and
 * replays them verbatim, so the loader's `ETag` / `Content-Range` / `Content-Length` checks see
 * exactly what the deployed origin sent. It is loaded with `--import`, which Node also applies
 * inside the SDK's routing worker thread (the thread that does the fetching).
 *
 * Environment: `VALHALLA_CLIENT_CACHE` (directory, default `build/client-cache`) and
 * `VALHALLA_CLIENT_CACHE_LIMIT` (bytes, default 2 GiB).
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';

const directory = process.env.VALHALLA_CLIENT_CACHE ?? join('build', 'client-cache');
/** Only dataset reads are cached, and only up to this much; the ranges are usually a few hundred MiB. */
const limit = Number(process.env.VALHALLA_CLIENT_CACHE_LIMIT ?? 2 * 1024 * 1024 * 1024);
const logPath = join(directory, 'fetch-log.jsonl');

mkdirSync(directory, { recursive: true });
let storedBytes = 0;
const realFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = String(init.method ?? 'GET').toUpperCase();
  const range = new Headers(init.headers ?? {}).get('Range') ?? '';
  // Everything else — the manifest, whole-object HEADs, other hosts — is passed straight through.
  if (method !== 'GET' || !url.includes('/datasets/')) return realFetch(input, init);
  const key = createHash('sha256').update(`${url}|${range}`).digest('hex');
  const metaPath = join(directory, `${key}.json`);
  const bodyPath = join(directory, `${key}.bin`);
  const record = (source, status, bytes) => appendFileSync(logPath, `${JSON.stringify({ threadId, url, range, status, source, bytes })}\n`);
  if (existsSync(metaPath) && existsSync(bodyPath)) {
    const stored = JSON.parse(readFileSync(metaPath, 'utf8'));
    const body = readFileSync(bodyPath);
    record('cache', stored.status, body.byteLength);
    return new Response(body, { status: stored.status, headers: stored.headers });
  }
  const response = await realFetch(input, init);
  if ((response.status === 200 || response.status === 206) && response.body) {
    const body = Buffer.from(await response.arrayBuffer());
    if (storedBytes + body.byteLength <= limit) {
      writeFileSync(bodyPath, body);
      writeFileSync(metaPath, JSON.stringify({ status: response.status, headers: [...response.headers] }));
      storedBytes += body.byteLength;
    }
    record('network', response.status, body.byteLength);
    return new Response(body, { status: response.status, headers: response.headers });
  }
  record('other', response.status, 0);
  return response;
};
