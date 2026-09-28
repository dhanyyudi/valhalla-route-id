#!/usr/bin/env node
/**
 * Deployed end-to-end verification of a published release.
 *
 * The delivery manifest proves what the origin *said*; this script proves what it *serves*, on
 * the real 2 GB archive, through the same HTTP store the application uses:
 *
 * 1. `HEAD` the deployed archive and print `status`, `Content-Length`, `ETag` and
 *    `Last-Modified` — the four values `packages/valhalla-core/src/store.ts` inspects before it
 *    trusts an object (`head()` requires the length, the ETag the manifest declares and a
 *    parseable `Last-Modified`).
 * 2. Fetch two ranges at large offsets inside the archive and assert `206`, the exact
 *    `Content-Range`, the exact `Content-Length`, the manifest's ETag and no content encoding.
 *    When the release directory is present, the same range is read from the local file and the
 *    two sha256 digests are compared, so "the origin served a range" becomes "the origin served
 *    the released bytes".
 * 3. Run one real `auto` route from Jakarta to Bandung through the SDK against the **deployed**
 *    manifest URL with the application's transport (`indexed-tar`) and memory budget, printing
 *    the distance, the duration and the bytes fetched.
 *
 * Read the route result with the numbers that follow it. The route reads **89 GiB** of tile bytes
 * for **18 distinct ranges** (207 MiB) on this release: the loader keeps no tile bytes and
 * re-validates every re-read by sha256, so a cacheless Node client cannot finish a 156 km route
 * inside the SDK host's 300 s maximum, and its first uncached tile read (tens of MB) exceeds the
 * loader's default 10 s per-request timeout. Run it the way a browser client behaves — with the
 * Worker's own `Cache-Control: immutable` honoured — by preloading the cache:
 *
 *   node --import tools/publish/client-cache.mjs tools/publish/verify-deployed.mjs \
 *     --manifest-url https://<host>/datasets/<release>/manifest.json
 *
 * The route step then reports the network bytes (the distinct ranges, fetched from the deployed
 * origin) separately from the cache hits the loader re-read and re-validated locally.
 *
 * Usage:
 *   node [--import tools/publish/client-cache.mjs] tools/publish/verify-deployed.mjs \
 *     --manifest-url https://<host>/datasets/<release>/manifest.json [--timeout-ms 60000] [--skip-route]
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createRouter } from 'valhalla-server/node';

/**
 * The application's own budget. The two largest tiles in this release are 48,442,160 B and
 * 37,395,280 B, so the SDK default of 32 MiB refuses to initialize against this dataset
 * (`INVALID_REQUEST: Memory budget must fit the largest individual tile in this dataset.`).
 */
const MEMORY_BUDGET_BYTES = 100663296;
/**
 * The SDK host's default operation deadline is 30 s, which cannot finish a 156 km route across
 * Java on this graph (the corpus measures ~88 s for `jakarta-bandung-auto`). 300 s is the
 * host's documented maximum and what `tools/verify/compare.mjs` uses.
 */
const ROUTE_TIMEOUT_MS = 300000;
/**
 * The per-request fetch timeout, i.e. how long one tile range may take. The SDK default is 10 s,
 * which is ample on localhost and not enough for the 48.4 MB and 37.4 MB Jakarta tiles over a
 * WAN — the very first tile read dies with `TIMEOUT: Tile request timed out.` and the route never
 * starts. 60 s is the documented maximum.
 */
const REQUEST_TIMEOUT_MS = 60000;
/** Large offsets inside the 2 GB archive: neither can be answered from a cached prefix. */
const DEFAULT_RANGES = [[1000000000, 1000010239], [1900000000, 1900010239]];
/** `tools/verify/corpus.jsonl` case `jakarta-bandung-auto`. */
const JAKARTA = { lat: -6.1754, lon: 106.8272 };
const BANDUNG = { lat: -6.9175, lon: 107.6191 };

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const headers = response => ['content-length', 'content-range', 'content-encoding', 'etag', 'last-modified', 'accept-ranges', 'cache-control']
  .map(name => `${name}: ${response.headers.get(name) ?? '(absent)'}`).join('\n    ');

const { values } = parseArgs({ options: {
  'manifest-url': { type: 'string' },
  'release-dir': { type: 'string' },
  'timeout-ms': { type: 'string' },
  range: { type: 'string', multiple: true },
  'skip-route': { type: 'boolean' },
  help: { type: 'boolean' },
} });
if (values.help || !values['manifest-url']) {
  console.log('Usage: node [--import tools/publish/client-cache.mjs] tools/publish/verify-deployed.mjs --manifest-url https://<host>/datasets/<release>/manifest.json [--release-dir public/datasets/<release>] [--timeout-ms 60000] [--range 1000000000-1000010239] [--skip-route]');
  process.exit(values.help ? 0 : 1);
}
const requestTimeoutMs = Number(values['timeout-ms'] ?? REQUEST_TIMEOUT_MS);
if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 60000) throw new Error('--timeout-ms must be 1–60000.');
// The client cache (when preloaded) appends one line per dataset read here, which is how this
// script can tell the origin's bytes apart from the loader's local re-reads.
const cacheLog = path.join(process.env.VALHALLA_CLIENT_CACHE ?? path.join('build', 'client-cache'), 'fetch-log.jsonl');
if (existsSync(cacheLog)) writeFileSync(cacheLog, '');

const manifestUrl = new URL(values['manifest-url']);
const manifest = await (await fetch(manifestUrl, { cache: 'no-store' })).json();
const releaseDir = path.resolve(values['release-dir'] ?? path.join('public', 'datasets', manifest.release));
const archiveUrl = new URL(manifest.archive.url, manifestUrl).href;
const archiveSize = manifest.archive.size;
const expectedEtag = manifest.archive.etag;
const ranges = (values.range ?? DEFAULT_RANGES.map(([start, end]) => `${start}-${end}`))
  .map(text => { const [start, end] = text.split('-').map(Number); if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) throw new Error(`Bad --range ${text}`); return [start, end]; });

const problems = [];
const check = (condition, message) => { if (!condition) problems.push(message); return condition; };
const noEncoding = response => !response.headers.has('content-encoding') || response.headers.get('content-encoding') === 'identity';

console.log(`manifest ${manifestUrl.href}`);
console.log(`  release ${manifest.release}, schema ${manifest.schema}, tiles ${Object.keys(manifest.tiles).length}`);
console.log(`  declared archive ${archiveSize} bytes, validator ${expectedEtag}`);
console.log(`  declared config ${manifest.config.sha256}`);
console.log(`archive ${archiveUrl}\n`);

// --- 1: HEAD ------------------------------------------------------------------------------
// `Accept-Encoding: identity` because Cloudflare's edge compresses a compressible response when
// the client advertises support — which is why the check below is about the object's own
// representation. The archive is `application/octet-stream` and is never re-encoded, which the
// second HEAD (with a browser's own header) confirms.
const head = await fetch(archiveUrl, { method: 'HEAD', cache: 'no-store', headers: { 'Accept-Encoding': 'identity' } });
console.log(`(a) HEAD ${head.status}\n    ${headers(head)}`);
check(head.status === 200, `HEAD answered ${head.status}`);
check(head.headers.get('content-length') === String(archiveSize), `HEAD Content-Length ${head.headers.get('content-length')} != ${archiveSize}`);
check(head.headers.get('etag') === expectedEtag, `HEAD ETag ${head.headers.get('etag')} != manifest ${expectedEtag}`);
check(noEncoding(head), `HEAD Content-Encoding ${head.headers.get('content-encoding')}`);
check(Number.isFinite(Date.parse(head.headers.get('last-modified') ?? '')), 'HEAD Last-Modified is not parseable');

const headCompressed = await fetch(archiveUrl, { method: 'HEAD', cache: 'no-store', headers: { 'Accept-Encoding': 'gzip, deflate, br, zstd' } });
console.log(`    HEAD with a browser's Accept-Encoding: ${headCompressed.status}, content-length ${headCompressed.headers.get('content-length')}, content-encoding ${headCompressed.headers.get('content-encoding') ?? '(absent)'}, etag ${headCompressed.headers.get('etag')}`);
check(headCompressed.headers.get('etag') === expectedEtag && noEncoding(headCompressed), 'the archive is re-encoded for a compressing client');

// --- 2: ranged reads at large offsets -----------------------------------------------------
for (const [start, end] of ranges) {
  const length = end - start + 1;
  const response = await fetch(archiveUrl, { headers: { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity' }, cache: 'no-store' });
  const body = new Uint8Array(await response.arrayBuffer());
  const expectedRange = `bytes ${start}-${end}/${archiveSize}`;
  console.log(`\n(b) Range bytes=${start}-${end}\n    ${headers(response)}`);
  console.log(`    body ${body.byteLength} bytes, sha256 ${sha256(body)}`);
  check(response.status === 206, `range ${start}-${end} answered ${response.status}, expected 206`);
  check(response.headers.get('content-range') === expectedRange, `Content-Range ${response.headers.get('content-range')} != ${expectedRange}`);
  check(response.headers.get('content-length') === String(length), `Content-Length ${response.headers.get('content-length')} != ${length}`);
  check(response.headers.get('etag') === expectedEtag, `range ETag ${response.headers.get('etag')} != manifest ${expectedEtag}`);
  check(noEncoding(response), `range Content-Encoding ${response.headers.get('content-encoding')}`);
  check(body.byteLength === length, `body ${body.byteLength} bytes != ${length}`);
  // The origin's bytes must be the released bytes, not merely the right length.
  const localPath = path.join(releaseDir, manifest.archive.url);
  try {
    await stat(localPath);
    const file = await open(localPath);
    try {
      const local = Buffer.alloc(length);
      const { bytesRead } = await file.read(local, 0, length, start);
      const localSha = sha256(local.subarray(0, bytesRead));
      console.log(`    local ${localPath} bytes ${start}-${start + bytesRead - 1}, sha256 ${localSha}`);
      check(bytesRead === length, `local read returned ${bytesRead} bytes, expected ${length}`);
      check(localSha === sha256(body), `deployed bytes differ from the released file at offset ${start}`);
    } finally { await file.close(); }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    console.log(`    (no local ${localPath}; deployed bytes are not compared against the released file)`);
  }
}

// --- 3: a real route through the SDK against the deployed manifest -------------------------
if (!values['skip-route']) {
  console.log(`\n(c) SDK route ${JAKARTA.lat},${JAKARTA.lon} -> ${BANDUNG.lat},${BANDUNG.lon}, costing auto`);
  const router = await createRouter({ manifestUrl: manifestUrl.href, transport: 'indexed-tar', memoryBudgetBytes: MEMORY_BUDGET_BYTES, routeTimeoutMs: ROUTE_TIMEOUT_MS, timeoutMs: requestTimeoutMs });
  try {
    const startup = router.startup;
    console.log(`    startup release ${startup.release}, memoryBudgetBytes ${startup.memoryBudgetBytes}, supportedCostings ${startup.supportedCostings.join(', ')}`);
    console.log(`    startup bytes ${startup.graphStartupBytes} over ${startup.graphStartupRequests} requests, config sha256 ${startup.configSha256}`);
    check(startup.release === manifest.release, `router started release ${startup.release}`);
    check(startup.memoryBudgetBytes === MEMORY_BUDGET_BYTES, `router memoryBudgetBytes ${startup.memoryBudgetBytes}`);
    const routeStart = Date.now();
    try {
      const result = await router.route({ locations: [JAKARTA, BANDUNG], costing: 'auto' });
      const summary = result.native.trip.summary;
      const loader = result.diagnostics.loader;
      console.log(`    distance ${summary.length} km, duration ${summary.time} s, cost ${summary.cost}`);
      console.log(`    routeMs ${result.diagnostics.routeMs.toFixed(1)} ms, hostRouteMs ${result.diagnostics.hostRouteMs.toFixed(1)} ms, decodedCacheHits ${result.diagnostics.decodedCacheHits}, wall ${((Date.now() - routeStart) / 1000).toFixed(1)} s`);
      console.log(`    bytes validated ${loader.bytes} over ${loader.requests} requests (${loader.tileDownloads} tile downloads, ${loader.metadataBytes} metadata bytes, ${loader.retries} retries, deduplicated ${loader.deduplicated}), ${(loader.sequentialWaitMs / 1000).toFixed(1)} s in download waits`);
      check(summary.length > 0 && summary.time > 0, `route returned length ${summary.length}, time ${summary.time}`);
      check(loader.bytes > 0, 'route fetched no bytes, so it did not read the deployed archive');
      // Informational: the same request answered by the pinned native binary and by the SDK's own
      // corpus half (`tools/verify/native.jsonl`, `tools/verify/wasm.jsonl`, case 1). Both are
      // compared the way `tools/verify/compare.mjs` compares them — through `JSON.stringify` of
      // the parsed value — because the native serializer writes integral doubles as `55.0` where
      // JavaScript writes `55`. The corpus is what verifies native-versus-WASM equality; this line
      // says whether the deployed origin reproduced that answer from the published bytes.
      const answer = JSON.stringify(result.native);
      for (const [label, file] of [['native reference', 'native.jsonl'], ['recorded SDK answer', 'wasm.jsonl']]) {
        const referencePath = path.join('tools', 'verify', file);
        if (!existsSync(referencePath)) continue;
        const reference = JSON.stringify(JSON.parse(readFileSync(referencePath, 'utf8').split('\n')[0]));
        const identical = reference === answer;
        console.log(`    corpus ${label} (jakarta-bandung-auto): ${identical ? 'byte-identical' : 'DIFFERENT'} (${reference.length} vs ${answer.length} bytes, canonical JSON)`);
        check(identical, `the deployed route differs from the corpus ${label} for this request`);
      }
    } catch (error) {
      console.error(`    route failed after ${((Date.now() - routeStart) / 1000).toFixed(1)} s: ${error.code ?? error.name}: ${error.message}`);
      // What did it manage to read before the host stopped it? This is the difference between
      // "the origin is slow" and "the engine is slow", and it is the number that decides whether
      // the 300 s host maximum is enough for this request over the network.
      try {
        const { metrics } = await router.diagnostics();
        console.error(`    cumulative loader metrics at failure: ${metrics.bytes} bytes over ${metrics.requests} requests, ${metrics.tileDownloads} tile downloads, ${metrics.metadataBytes} metadata bytes, ${metrics.retries} retries, ${(metrics.sequentialWaitMs / 1000).toFixed(1)} s in download waits`);
      } catch (diagnosticError) {
        console.error(`    (diagnostics unavailable: ${diagnosticError.message})`);
      }
      console.error('    This request needs thousands of tile reads; without a client cache the SDK re-downloads each one.');
      console.error('    Re-run with the browser-equivalent immutable cache: node --import tools/publish/client-cache.mjs ...');
      problems.push(`route failed: ${error.code ?? error.name}: ${error.message}`);
    }
  } finally {
    await router.dispose();
  }
  // Where did those validated bytes come from? With `tools/publish/client-cache.mjs` preloaded the
  // origin serves each distinct range once and the loader's re-reads are local; without it, every
  // re-read is another download of the same range.
  if (existsSync(cacheLog) && readFileSync(cacheLog, 'utf8').trim()) {
    const entries = readFileSync(cacheLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const bytes = source => entries.filter(entry => entry.source === source).reduce((total, entry) => total + entry.bytes, 0);
    const count = source => entries.filter(entry => entry.source === source).length;
    const distinct = new Set(entries.map(entry => `${entry.url}|${entry.range}`)).size;
    console.log(`    client cache: ${count('network')} origin responses (${(bytes('network') / 1024 / 1024).toFixed(1)} MiB) for ${distinct} distinct ranges, ${count('cache')} local hits (${(bytes('cache') / 1024 / 1024).toFixed(1)} MiB re-read and re-validated)`);
  } else {
    console.log('    client cache: not active (every loader read went to the origin)');
  }
}

if (problems.length) {
  console.error(`\nFAILED with ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log('\nOK: the deployed origin served the released archive and routed a real request.');
}
