import { createServer } from 'node:http';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const TYPES = { '.json': 'application/json', '.tar': 'application/octet-stream', '.gph': 'application/octet-stream' };
const relative = url => url.replace(/^\.\//, '');

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
 * Serve one release directory over HTTP with byte ranges, mounted under its release name.
 *
 * The mount prefix is not cosmetic: the SDK's loader requires the manifest URL's parent
 * directory to equal `manifest.release` (packages/valhalla-core/src/loader.ts), so callers
 * fetch `${url}/manifest.json` and the loader accepts the release identity it validated.
 *
 * @param {{ root: string, port?: number }} [options] release directory to serve
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export function serveDataset(options = {}) {
  const { root, port = 8788 } = options;
  const directory = resolve(root);
  const manifest = readManifest(directory);
  const etags = manifestEtags(manifest);
  const mount = `/${manifest.release}`;

  const server = createServer((request, response) => {
    const fail = (status, message) => { response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(message); };
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
      if (start >= size || start > end) { response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
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
  return new Promise(ready => server.listen(port, () => ready({
    url: `http://localhost:${port}${mount}`,
    close: () => new Promise(done => {
      // The SDK's fetch keeps sockets alive; without this the close callback never fires.
      server.close(done);
      server.closeIdleConnections();
    }),
  })));
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
  serveDataset({ root, port }).then(({ url }) => console.log(`serving ${root} on ${url} — manifest ${url}/manifest.json`));
}
