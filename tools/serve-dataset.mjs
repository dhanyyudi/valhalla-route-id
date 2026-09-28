import { createServer } from 'node:http';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const TYPES = { '.json': 'application/json', '.tar': 'application/octet-stream', '.gph': 'application/octet-stream' };
const relative = url => url.replace(/^\.\//, '');

/**
 * The same CORS grant the deployed Worker carries (worker/index.ts). Without it the documented
 * local-development flow — SPA on `localhost:5173`, manifest here on port 8788 — never gets past
 * the browser's CORS check, whatever the dataset is. The graph is public, read-only data, so the
 * wildcard grants nothing a plain `curl` could not already read.
 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, ETag, Last-Modified',
};
const PREFLIGHT_HEADERS = 'Range, If-None-Match, If-Modified-Since';

const readManifest = releaseDir => JSON.parse(readFileSync(join(releaseDir, 'manifest.json'), 'utf8'));

/**
 * ETags must be the ones the release manifest declares: the SDK compares the response
 * ETag against the manifest value and fails with DATASET_MISMATCH on any difference
 * (packages/valhalla-core/src/store.ts). Inventing an ETag here breaks every route.
 * Keys are paths relative to the served release directory.
 */
function manifestEtags(manifest) {
  const etags = new Map();
  etags.set(relative(manifest.archive.url), manifest.archive.etag);
  etags.set(relative(manifest.config.url), `"${manifest.config.sha256}"`);
  for (const entry of Object.values(manifest.tiles)) etags.set(`tiles/${entry.path}`, entry.etag ?? `"${entry.sha256}"`);
  return etags;
}

/**
 * The address this server binds and advertises.
 *
 * Loopback only, deliberately. Every caller reads the release from the same machine — the two
 * smoke suites, the corpus runners under `tools/verify/`, and local development — while
 * `server.listen(port)` with no host binds the wildcard address and makes macOS raise its
 * "Do you want the application node to accept incoming network connections?" prompt on every
 * start, for exposure nothing here uses. Naming `127.0.0.1` in the returned URL as well keeps
 * callers off `localhost`, which can resolve to `::1` first and miss the IPv4 socket.
 */
const HOST = '127.0.0.1';

/**
 * Serve one release directory over HTTP with byte ranges, mounted under its release name.
 *
 * The mount prefix is not cosmetic: the SDK's loader requires the manifest URL's parent
 * directory to equal `manifest.release` (packages/valhalla-core/src/loader.ts), so callers
 * fetch `${url}/manifest.json` and the loader accepts the release identity it validated.
 *
 * @param {{ root: string, port?: number }} [options] release directory to serve
 * @returns {Promise<{ url: string, close: () => Promise<void> }>} `url` is the loopback mount
 *   point; rejects when the port cannot be bound
 */
export function serveDataset(options = {}) {
  const { root, port = 8788 } = options;
  const directory = resolve(root);
  const manifest = readManifest(directory);
  const etags = manifestEtags(manifest);
  const mount = `/${manifest.release}`;

  const server = createServer((request, response) => {
    const fail = (status, message) => { response.writeHead(status, { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' }).end(message); };
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        ...CORS,
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': request.headers['access-control-request-headers'] ?? PREFLIGHT_HEADERS,
        'Access-Control-Max-Age': '86400',
      }).end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'method not allowed');
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
    catch { return fail(400, 'malformed request path'); }
    if (pathname !== mount && !pathname.startsWith(`${mount}/`)) return fail(404, 'not found');
    const name = pathname.slice(mount.length).replace(/^\/+/, '');
    const path = resolve(directory, name);
    // Reject traversal outright, then confirm resolve containment rather than a string prefix:
    // neither `../` nor an absolute path may leave the served release.
    if (!name || name.split('/').includes('..') || (path !== directory && !path.startsWith(`${directory}${sep}`))) return fail(404, 'not found');
    let stats;
    try { stats = statSync(path); } catch { return fail(404, 'not found'); }
    if (!stats.isFile()) return fail(404, 'not found');
    const size = stats.size;
    const headers = {
      ...CORS,
      'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'ETag': etags.get(name) ?? `"${size.toString(16)}"`,
      'Last-Modified': stats.mtime.toUTCString(),
      'Cache-Control': 'public, max-age=31536000, immutable',
    };
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
      if (start >= size || start > end) { response.writeHead(416, { ...CORS, 'Content-Range': `bytes */${size}` }).end(); return; }
      response.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
      if (request.method === 'HEAD') { response.end(); return; }
      const stream = createReadStream(path, { start, end });
      stream.on('error', () => response.destroy());
      response.on('close', () => stream.destroy());
      return void stream.pipe(response);
    }
    response.writeHead(200, { ...headers, 'Content-Length': size });
    if (request.method === 'HEAD') { response.end(); return; }
    const stream = createReadStream(path);
    stream.on('error', () => response.destroy());
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  });
  return new Promise((ready, reject) => {
    // Without this the promise never settles on a bind failure (`EADDRINUSE`), and both smoke
    // suites' `beforeAll` wait on it until the test runner times out with no explanation. A
    // `reject` after `ready` has already run is a no-op, so this also keeps a later socket error
    // from becoming an uncaught exception.
    server.on('error', reject);
    server.listen(port, HOST, () => ready({
      url: `http://${HOST}:${port}${mount}`,
      close: () => new Promise(done => {
        // The SDK's fetch keeps sockets alive; without this the close callback never fires.
        server.close(done);
        server.closeIdleConnections();
      }),
    }));
  });
}

/** Resolve a release directory: `root` itself, or the single release directory beneath it. */
function releaseDirectory(root) {
  if (existsSync(join(root, 'manifest.json'))) return root;
  const releases = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(root, entry.name, 'manifest.json')))
    .map(entry => entry.name);
  if (releases.length !== 1) throw new Error(`Expected exactly one release directory under ${root}, found ${releases.length}: ${releases.join(', ') || 'none'}.`);
  return join(root, releases[0]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = releaseDirectory(process.argv[2] ?? join('public', 'datasets'));
  const port = Number(process.argv[3] ?? 8788);
  serveDataset({ root, port })
    .then(({ url }) => console.log(`serving ${root} on ${url} — manifest ${url}/manifest.json`))
    .catch(error => {
      // A busy port must read as a busy port, not as a server that started and answered nothing.
      console.error(`serve-dataset: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
