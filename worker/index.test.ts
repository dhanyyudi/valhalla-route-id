import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from './index';

// 2048 bytes of non-repeating-enough filler: every byte value is derived from its
// index, so a wrong offset or a wrong length cannot accidentally compare equal.
const BODY = new Uint8Array(2048).map((_, index) => index % 251);
const RELEASE = 'test-release';
const GRAPH = `${RELEASE}/graph.tar`;
const MANIFEST = `${RELEASE}/manifest.json`;
const origin = (key: string) => `https://example.com/datasets/${key}`;

/** The ETag R2 reports, which is what the release manifest is generated from. */
let etag: string;

beforeAll(async () => {
  const stored = await env.GRAPH.put(GRAPH, BODY, { httpMetadata: { contentType: 'application/octet-stream' } });
  etag = stored.httpEtag;
  await env.GRAPH.put(
    MANIFEST,
    JSON.stringify({ release: RELEASE, archive: { url: 'graph.tar', size: String(BODY.byteLength), etag } }),
    { httpMetadata: { contentType: 'application/json' } },
  );
});

/**
 * Production R2 has two behaviours around an unsatisfiable range that the local simulator
 * does not, and both are what turned a ranged GET whose start is at or past EOF into
 * `HTTP 500` / `error code: 1101` on the deployed Worker. This wrapper restores them around
 * the real local bucket:
 *   * every ranged read is recorded in `askedFor`, so a test can assert the span the handler
 *     asked for rather than what the simulator chose to do with it;
 *   * with `rejects`, a read for a span that starts at or past EOF throws the way production
 *     does (`get: The requested range is not satisfiable (10039)`).
 */
function productionLikeGraph(bucket: R2Bucket, askedFor: string[], rejects: boolean): R2Bucket {
  return new Proxy(bucket, {
    get(target, property) {
      // Every other method is handed back bound to the real bucket: the runtime's bindings
      // reject a call whose `this` is the proxy ("Illegal invocation").
      if (property !== 'get') {
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (key: string, options?: R2GetOptions) => {
        const range = options?.range;
        const header = range instanceof Headers ? range.get('Range') : null;
        if (header !== null) {
          askedFor.push(header);
          const size = (await bucket.head(key))?.size ?? 0;
          // `bytes=<start>-[<end>]` is the only shape that can be unsatisfiable by starting at
          // or past EOF; a suffix range of a non-empty object is always satisfiable.
          const start = Number(/^bytes=(\d+)-/.exec(header)?.[1]);
          if (rejects && Number.isSafeInteger(start) && start >= size) {
            throw new Error('get: The requested range is not satisfiable (10039)');
          }
        }
        return bucket.get(key, options);
      };
    },
  }) as R2Bucket;
}

/** Drives the handler directly, against a bucket that behaves like the deployed one. */
function fetchWithGraph(graph: R2Bucket, init: RequestInit): Promise<Response> {
  return worker.fetch(new Request(origin(GRAPH), init), { ASSETS: env.ASSETS, GRAPH: graph });
}

describe('/datasets range handler', () => {
  it('answers a ranged GET with 206, the exact span, the manifest ETag and no encoding', async () => {
    const ranged = await SELF.fetch(origin(GRAPH), { headers: { Range: 'bytes=512-1023' } });

    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('Content-Range')).toBe('bytes 512-1023/2048');
    expect(ranged.headers.get('Content-Length')).toBe('512');
    expect(ranged.headers.get('ETag')).toBe(etag);
    expect(ranged.headers.get('Content-Encoding')).toBeNull();
    expect(ranged.headers.get('Accept-Ranges')).toBe('bytes');
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(BODY.slice(512, 1024));
  });

  it('resolves a suffix range to absolute bytes instead of ignoring it', async () => {
    const suffix = await SELF.fetch(origin(GRAPH), { headers: { Range: 'bytes=-256' } });

    expect(suffix.status).toBe(206);
    expect(suffix.headers.get('Content-Range')).toBe('bytes 1792-2047/2048');
    expect(suffix.headers.get('Content-Length')).toBe('256');
    expect(suffix.headers.get('ETag')).toBe(etag);
    const body = new Uint8Array(await suffix.arrayBuffer());
    expect(body.byteLength).toBe(256);
    expect(body).toEqual(BODY.slice(1792, 2048));
  });

  it('clamps an open-ended range and a suffix longer than the object', async () => {
    const open = await SELF.fetch(origin(GRAPH), { headers: { Range: 'bytes=2047-' } });
    expect(open.status).toBe(206);
    expect(open.headers.get('Content-Range')).toBe('bytes 2047-2047/2048');
    expect(new Uint8Array(await open.arrayBuffer())).toEqual(BODY.slice(2047, 2048));

    const long = await SELF.fetch(origin(GRAPH), { headers: { Range: 'bytes=-99999' } });
    expect(long.status).toBe(206);
    expect(long.headers.get('Content-Range')).toBe('bytes 0-2047/2048');
    expect((await long.arrayBuffer()).byteLength).toBe(2048);
  });

  it('serves the whole object as 200 with the full body and its own validator', async () => {
    const whole = await SELF.fetch(origin(GRAPH));

    expect(whole.status).toBe(200);
    expect(whole.headers.get('Content-Length')).toBe('2048');
    expect(whole.headers.get('ETag')).toBe(etag);
    expect(whole.headers.get('Content-Range')).toBeNull();
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(BODY);

    const manifest = await SELF.fetch(origin(MANIFEST));
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get('Content-Type')).toBe('application/json');
    expect(await manifest.json()).toMatchObject({ release: RELEASE, archive: { etag } });
  });

  it('lets a cross-origin browser read a 200 and a 206, exposing the range validators', async () => {
    // The documented local-development flow runs the SPA on localhost against this origin, so a
    // response without `Access-Control-Allow-Origin` is a hard failure for a first-time
    // contributor: the SDK's `fetch` rejects before it can validate anything.
    const crossOrigin = { Origin: 'http://localhost:5173' };

    const whole = await SELF.fetch(origin(MANIFEST), { headers: crossOrigin });
    expect(whole.status).toBe(200);
    expect(whole.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(whole.headers.get('Access-Control-Expose-Headers')).toBe('Content-Range, Content-Length, ETag, Last-Modified');

    const ranged = await SELF.fetch(origin(GRAPH), { headers: { ...crossOrigin, Range: 'bytes=512-1023' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(ranged.headers.get('Access-Control-Expose-Headers')).toBe('Content-Range, Content-Length, ETag, Last-Modified');
    // The exposed headers are the ones the store actually validates a ranged read against.
    expect(ranged.headers.get('Content-Range')).toBe('bytes 512-1023/2048');
    expect(ranged.headers.get('ETag')).toBe(etag);

    // A 416 is readable too, so a client can retry instead of seeing an opaque network error.
    const unsatisfiable = await SELF.fetch(origin(GRAPH), { headers: { ...crossOrigin, Range: 'bytes=99999-' } });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('answers a CORS preflight for a dataset object without touching the bucket', async () => {
    const preflight = await SELF.fetch(origin(GRAPH), {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range' },
    });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toBe('GET, HEAD, OPTIONS');
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toBe('range');
    expect((await preflight.arrayBuffer()).byteLength).toBe(0);

    // With no requested headers named, the documented set is advertised.
    const bare = await SELF.fetch(origin(GRAPH), { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } });
    expect(bare.status).toBe(204);
    expect(bare.headers.get('Access-Control-Allow-Headers')).toBe('Range, If-None-Match, If-Modified-Since');
  });

  it('answers HEAD with the size, the same ETag and a parseable Last-Modified, and no body', async () => {
    const head = await SELF.fetch(origin(GRAPH), { method: 'HEAD' });

    expect(head.status).toBe(200);
    expect(head.headers.get('Content-Length')).toBe('2048');
    expect(head.headers.get('ETag')).toBe(etag);
    expect(Number.isFinite(Date.parse(head.headers.get('Last-Modified') ?? ''))).toBe(true);
    expect((await head.arrayBuffer()).byteLength).toBe(0);

    // Exactly what scripts/dataset-etags.js reads back when it turns the live responses
    // into the delivery manifest: a strong quoted validator and an uncompressed object.
    expect(head.headers.get('ETag')).toMatch(/^"[\x21\x23-\x7e]{1,256}"$/);
    expect(head.headers.get('Content-Encoding')).toBeNull();

    // HEAD mirrors the ranged GET's headers without paying for the bytes.
    const rangedHead = await SELF.fetch(origin(GRAPH), { method: 'HEAD', headers: { Range: 'bytes=512-1023' } });
    expect(rangedHead.status).toBe(206);
    expect(rangedHead.headers.get('Content-Range')).toBe('bytes 512-1023/2048');
    expect(rangedHead.headers.get('Content-Length')).toBe('512');
    expect(rangedHead.headers.get('ETag')).toBe(etag);
    expect((await rangedHead.arrayBuffer()).byteLength).toBe(0);
  });

  it('returns 404 for a key that is not in the bucket', async () => {
    const missing = await SELF.fetch(origin(`${RELEASE}/tiles/9/999/999.gph`));
    expect(missing.status).toBe(404);

    const rangedMissing = await SELF.fetch(origin(`${RELEASE}/tiles/9/999/999.gph`), { headers: { Range: 'bytes=0-15' } });
    expect(rangedMissing.status).toBe(404);

    const headMissing = await SELF.fetch(origin(`${RELEASE}/tiles/9/999/999.gph`), { method: 'HEAD' });
    expect(headMissing.status).toBe(404);
  });

  it('returns 416 with an unsatisfied Content-Range for an unsatisfiable range', async () => {
    for (const range of ['bytes=99999-100000', 'bytes=2048-3000', 'bytes=2048-', 'bytes=-0', 'bytes=abc', 'bytes=1023-512', 'bytes=0-1,5-6']) {
      const response = await SELF.fetch(origin(GRAPH), { headers: { Range: range } });
      expect(response.status, `Range: ${range}`).toBe(416);
      expect(response.headers.get('Content-Range'), `Range: ${range}`).toBe('bytes */2048');
      expect((await response.arrayBuffer()).byteLength, `Range: ${range}`).toBeLessThan(2048);
    }
  });

  it('decides 416 from metadata when the range starts at or past EOF, without asking R2 for the span', async () => {
    // Pre-fix, the handler handed this span to R2 and only inspected what came back. The
    // simulator ignores the range and serves the whole object, which the cross-check then
    // turns into a 416 — so a status-only assertion passes on that code and hides the fact
    // that production R2 throws on the very same call. The recorded reads are therefore the
    // part of this test that fails on it.
    const askedFor: string[] = [];
    const graph = productionLikeGraph(env.GRAPH, askedFor, false);
    const ranges = [
      `bytes=${BODY.byteLength}-`,
      `bytes=${BODY.byteLength + 1}-`,
      'bytes=999999999999-',
      `bytes=${BODY.byteLength}-${BODY.byteLength + 10}`,
    ];

    for (const range of ranges) {
      const response = await fetchWithGraph(graph, { headers: { Range: range, Origin: 'http://localhost:5173' } });
      expect(response.status, `Range: ${range}`).toBe(416);
      expect(response.headers.get('Content-Range'), `Range: ${range}`).toBe(`bytes */${BODY.byteLength}`);
      expect(response.headers.get('Access-Control-Allow-Origin'), `Range: ${range}`).toBe('*');
      expect(response.headers.get('Access-Control-Expose-Headers'), `Range: ${range}`).toBe(
        'Content-Range, Content-Length, ETag, Last-Modified',
      );
      expect((await response.arrayBuffer()).byteLength, `Range: ${range}`).toBeLessThan(BODY.byteLength);
    }

    expect(askedFor).toEqual([]);
  });

  it('survives an R2 that throws for an unsatisfiable range instead of ignoring it', async () => {
    // This is the production failure itself: the throw once escaped as `HTTP 500` with
    // `error code: 1101` and no CORS grant. The handler now also catches storage errors (next
    // test), but an unsatisfiable span must still be answered as 416 without asking R2 for it.
    const askedFor: string[] = [];
    const graph = productionLikeGraph(env.GRAPH, askedFor, true);

    for (const range of [`bytes=${BODY.byteLength}-`, 'bytes=999999999999-']) {
      const response = await fetchWithGraph(graph, { headers: { Range: range, Origin: 'http://localhost:5173' } });
      expect(response.status, `Range: ${range}`).toBe(416);
      expect(response.headers.get('Content-Range'), `Range: ${range}`).toBe(`bytes */${BODY.byteLength}`);
      expect(response.headers.get('Access-Control-Allow-Origin'), `Range: ${range}`).toBe('*');
    }

    expect(askedFor).toEqual([]);
  });

  it('answers a storage failure with a retryable 503 that a cross-origin browser can read', async () => {
    const failing = new Proxy(env.GRAPH, {
      get(target, property) {
        if (property === 'get' || property === 'head') return async () => { throw new Error('R2 internal error'); };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as R2Bucket;
    for (const init of [{ method: 'GET' }, { method: 'HEAD' }, { headers: { Range: 'bytes=0-9' } }] as RequestInit[]) {
      const response = await fetchWithGraph(failing, { ...init, headers: { ...(init.headers as Record<string, string>), Origin: 'http://localhost:5173' } });
      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('1');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    }
  });

  it('never answers a request that carries a Range header with 200', async () => {
    const ranges = ['bytes=0-0', 'bytes=512-1023', 'bytes=-1', 'bytes=-99999', 'bytes=0-', 'bytes=99999-', 'bytes=99999-100000', 'bytes=-0', 'bytes=abc', 'bytes=', 'bytes=0-1,5-6', 'items=0-1'];
    for (const range of ranges) {
      const status = (await SELF.fetch(origin(GRAPH), { headers: { Range: range } })).status;
      expect(status === 206 || status === 416, `Range: ${range} answered ${status}`).toBe(true);
    }
  });

  it('refuses a path-traversal attempt instead of serving a graph object', async () => {
    const attempts = [
      '..%2f..%2fetc%2fpasswd',
      '..%2fmanifest.json',
      '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '../../../etc/passwd',
      '..',
      'a/../../b',
      '',
    ];
    for (const attempt of attempts) {
      const response = await SELF.fetch(`https://example.com/datasets/${attempt}`, { headers: { Range: 'bytes=0-15' } });
      // Either the Worker rejects the key (404) or the platform normalises the path
      // away and the SPA answers instead. Neither may serve graph bytes: the graph's
      // own validator must never come back, and no range may be reported.
      expect([200, 404], `attempt: ${attempt}`).toContain(response.status);
      expect(response.headers.get('Content-Range'), `attempt: ${attempt}`).toBeNull();
      expect(response.headers.get('ETag'), `attempt: ${attempt}`).not.toBe(etag);
    }

    // The one traversal that does reach the Worker is rejected outright.
    const rejected = await SELF.fetch('https://example.com/datasets/..%2f..%2fetc%2fpasswd', { headers: { Range: 'bytes=0-15' } });
    expect(rejected.status).toBe(404);
  });

  it('leaves non-dataset paths to the static assets binding', async () => {
    const shell = await SELF.fetch('https://example.com/');
    expect(shell.status).toBe(200);
    expect(shell.headers.get('Content-Type')).toContain('text/html');
    expect(await shell.text()).toContain('<!doctype html');
  });
});
