#!/usr/bin/env node
/**
 * Delivery manifest for a published release: the release manifest plus the validators the
 * **deployed** origin actually serves.
 *
 * `scripts/dataset-etags.js` (`pnpm run data:etags`) does this for a release whose objects are
 * all published — its manifest is uploaded beside them and the SDK compares the archive's and
 * every tile's validator against the response headers. This release publishes three objects
 * (`graph.tar`, `config.json`, `manifest.json`) and no tiles: the application uses the default
 * indexed-tar transport, which reads tile bytes as ranges inside `graph.tar`
 * (`packages/valhalla-core/src/loader.ts` passes the archive's validator for an indexed-tar read
 * and the tile's only for an individual-tile read), so HEADing 5,271 tile URLs that will never
 * be requested would spend the publication window proving nothing. The tile entries therefore
 * keep the validator the loader derives for them from their sha256, which is what the loader
 * checks the archive's bytes against anyway.
 *
 * What is checked here is exactly what `dataset-etags.js` checks, for the objects that are
 * published: for each one, a HEAD of the deployed URL that must answer `200`, with a
 * `Content-Length` equal to the released size, no content encoding other than `identity`, and a
 * strong quoted ETag. Nothing is invented: the ETag written into the delivery manifest is the
 * one the origin returned, and a failure names the offending object.
 *
 * The HEAD asks for `Accept-Encoding: identity` on purpose. Cloudflare's edge compresses a
 * compressible response (this release's JSON metadata, and only that — the 2 GB
 * `application/octet-stream` archive is served verbatim) when the client advertises support,
 * and it *weakens* the ETag of the compressed representation to `W/"…"`. That is a property of
 * the transfer, not of the stored object: the loader reads `manifest.json` and `config.json` as
 * documents and verifies the config by `config.sha256`, and only the archive/tile range reads
 * carry a validator (`packages/valhalla-core/src/loader.ts`), so the validator worth recording
 * is the one the stored object itself has. Asking for the identity representation is what makes
 * the length and the strong ETag observable at all.
 *
 * Usage:
 *   node tools/publish/manifest-etags.mjs --release <release> \
 *     --base-url https://<host>/datasets/<release>/ --output build/hosting/<release>-manifest.json
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

/** A strong entity-tag: quoted, non-empty, printable ASCII (no interior double quote). */
const STRONG_ETAG = /^"[\x21\x23-\x7e]{1,256}"$/;

const { values } = parseArgs({ options: {
  release: { type: 'string' },
  'base-url': { type: 'string' },
  'release-dir': { type: 'string' },
  output: { type: 'string' },
  help: { type: 'boolean' },
} });
if (values.help || !values.release || !values['base-url'] || !values.output) {
  console.log('Usage: node tools/publish/manifest-etags.mjs --release <release> \\\n' +
    '  --base-url https://<host>/datasets/<release>/ --output build/hosting/<release>-manifest.json [--release-dir public/datasets/<release>]');
  process.exit(values.help ? 0 : 1);
}

const releaseDir = path.resolve(values['release-dir'] ?? path.join('public', 'datasets', values.release));
const manifestPath = path.join(releaseDir, 'manifest.json');
if (path.resolve(values.output) === manifestPath) throw new Error('Use a separate output; the release manifest under public/datasets/ is never rewritten.');

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.release !== values.release) throw new Error(`${manifestPath} declares release ${manifest.release}, not ${values.release}.`);
const base = new URL(values['base-url']);
// The loader refuses a manifest whose URL parent directory is not its release
// (packages/valhalla-core/src/loader.ts), so a mistyped base URL must fail here rather than
// produce a delivery manifest that cannot be loaded.
if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash ||
    base.pathname.split('/').at(-2) !== manifest.release || !base.pathname.endsWith('/'))
  throw new Error('Base URL must end with /<manifest.release>/ and contain no credentials, query or fragment.');

/** The released size of one object, read from the release directory that was uploaded. */
async function releasedSize(relative, declared) {
  const local = await stat(path.join(releaseDir, relative));
  if (declared !== undefined && String(local.size) !== String(declared)) {
    throw new Error(`${relative} is ${local.size} bytes locally but the manifest declares ${declared}; publish the released bytes, not a rebuild.`);
  }
  return local.size;
}

/**
 * HEAD one published object and return the validators the origin served.
 *
 * The checks are the ones the SDK's HTTP store applies on a read
 * (`packages/valhalla-core/src/store.ts`): it rejects a response whose `ETag` differs from the
 * manifest, whose `Content-Length` is not the expected length, or that carries a non-identity
 * `Content-Encoding`. A `Content-Length` that only *looks* plausible is not enough — it is
 * compared with the released byte size, so a truncated or partial upload is caught here rather
 * than by the first user of the release.
 */
async function validator(relative, expectedSize) {
  const url = new URL(relative, base);
  if (!url.href.startsWith(base.href)) throw new Error(`Object URL escapes the release directory: ${url.href}`);
  const response = await fetch(url, { method: 'HEAD', credentials: 'omit', cache: 'no-store', headers: { 'Accept-Encoding': 'identity' }, signal: AbortSignal.timeout(30000) });
  const observed = {
    url: url.href,
    status: response.status,
    contentLength: response.headers.get('content-length'),
    contentEncoding: response.headers.get('content-encoding'),
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
  };
  if (response.status !== 200) throw new Error(`Unexpected HEAD status ${response.status} for ${observed.url}`);
  if (observed.contentLength !== String(expectedSize)) {
    throw new Error(`Deployed ${relative} is ${observed.contentLength} bytes, expected ${expectedSize}.`);
  }
  if (observed.contentEncoding !== null && observed.contentEncoding !== 'identity') {
    throw new Error(`Deployed ${relative} is served with Content-Encoding ${observed.contentEncoding}; the graph must be stored uncompressed.`);
  }
  if (!STRONG_ETAG.test(observed.etag ?? '')) throw new Error(`Missing strong ETag for ${relative}: ${JSON.stringify(observed.etag)}`);
  return observed;
}

const archive = await validator(manifest.archive.url, await releasedSize(manifest.archive.url, manifest.archive.size));
const config = await validator(manifest.config.url, await releasedSize(manifest.config.url));

// The published ETags only. `archive.etag` is the validator the loader checks every archive read
// against; `config.etag` is recorded so the delivery manifest names the exact object that was
// deployed (the loader verifies the config by `config.sha256` after downloading it).
manifest.archive.etag = archive.etag;
manifest.config = { ...manifest.config, etag: config.etag };
// Tile validators stay the released sha256, in the quoted form the loader derives for a tile
// entry that carries none (`etag: entry.etag ?? `"${entry.sha256}"``). No tile object is
// published, so there is no origin ETag to copy, and an indexed-tar read is validated against
// the archive validator above plus the tile's sha256 over the bytes it read.
let tilesCarried = 0;
for (const tile of Object.values(manifest.tiles)) {
  const derived = `"${tile.sha256}"`;
  if (tile.etag !== undefined && tile.etag !== derived) throw new Error(`Tile ${tile.path} carries ${tile.etag}, not its sha256; this script only carries released validators over.`);
  tile.etag = derived;
  tilesCarried += 1;
}

await mkdir(path.dirname(path.resolve(values.output)), { recursive: true });
// Exclusive creation prevents accidentally replacing a previously prepared delivery manifest.
await writeFile(values.output, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
const bytes = (await stat(values.output)).size;

console.log(`archive  HEAD ${archive.status} content-length ${archive.contentLength} content-encoding ${archive.contentEncoding ?? '(absent)'} etag ${archive.etag} last-modified ${archive.lastModified}`);
console.log(`config   HEAD ${config.status} content-length ${config.contentLength} content-encoding ${config.contentEncoding ?? '(absent)'} etag ${config.etag} last-modified ${config.lastModified}`);
console.log(`Wrote ${values.output} (${bytes} bytes); 2 live validators observed, ${tilesCarried} tile validators carried from sha256. Upload this manifest last, under ${manifest.release}/manifest.json.`);
