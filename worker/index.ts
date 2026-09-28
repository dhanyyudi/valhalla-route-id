// Serves the dataset's graph bytes out of R2 and the SPA out of the assets binding, so the
// deployed app and its data share one origin. The graph is public, read-only and
// credential-less, so `/datasets/*` also carries a wildcard CORS grant: without it the
// documented local-development flow (the SPA on `localhost:5173`, the manifest on this
// origin) is blocked by the browser before the SDK ever sees a byte.
//
// The HTTP store in packages/valhalla-core/src/store.ts is strict: a ranged read is
// rejected unless the response is 206 with `Content-Range: bytes <a>-<b>/<total>`,
// a `Content-Length` equal to the requested length, the archive's own `ETag` and no
// non-identity `Content-Encoding`; a whole read is rejected unless it is 200; and
// `head()` needs `Content-Length`, the same `ETag` and a parseable `Last-Modified`.
// Every one of those values is copied from R2 rather than derived from the request,
// and bodies are streamed so a 2 GB archive never lands in the Worker's 128 MB heap.
//
// Invariant: a request carrying a `Range` header is answered with 206 (exact bytes)
// or 416 — never with 200, and never with a 500. The deployed R2 binding *throws* for a
// range it cannot satisfy, so a span that starts at or past EOF is settled against object
// metadata before R2 is asked for it. The local simulator instead serves the *whole*
// object for such a range, so a range R2 ignores is also detected and turned into a 416
// rather than a 206 that misdescribes the body.

const PREFIX = '/datasets/';
const IMMUTABLE = 'public, max-age=31536000, immutable';

// Every `/datasets/*` response carries these, including the error responses: a browser in
// CORS mode cannot read a status or a body that arrives without `Access-Control-Allow-Origin`,
// so a 404 or a 416 would otherwise surface as an opaque network failure. The exposed headers
// are exactly the ones the SDK's store reads to validate a range (`Content-Range`,
// `Content-Length`, `ETag`) plus the `Last-Modified` its `head()` parses.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, ETag, Last-Modified',
};
const PREFLIGHT_HEADERS = 'Range, If-None-Match, If-Modified-Since';

/** What the client asked for, parsed without yet knowing the object's size. */
type RequestedRange =
  | { kind: 'none' }
  | { kind: 'bounded'; start: number; end: number }
  | { kind: 'open'; start: number }
  | { kind: 'suffix'; length: number }
  | { kind: 'invalid' };

/** The bytes R2 actually returned, as resolved against a size R2 knows. */
interface ServedRange {
  offset: number;
  length: number;
}

/**
 * Parses a single `bytes=` range. Anything else — a missing header, several ranges,
 * an unknown unit, a reversed or non-numeric span, a zero-length suffix — is
 * reported as `invalid`, which this Worker answers with 416 rather than by silently
 * streaming the whole archive.
 */
function parseRange(header: string | null): RequestedRange {
  if (header === null) return { kind: 'none' };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return { kind: 'invalid' };
  const [, first, last] = match;
  if (first === '' && last === '') return { kind: 'invalid' };
  if (first === '') {
    const length = Number(last);
    // A suffix-length of zero is unsatisfiable, and no byte range of a zero-length
    // representation is satisfiable either.
    return Number.isSafeInteger(length) && length > 0 ? { kind: 'suffix', length } : { kind: 'invalid' };
  }
  const start = Number(first);
  if (!Number.isSafeInteger(start)) return { kind: 'invalid' };
  if (last === '') return { kind: 'open', start };
  const end = Number(last);
  return Number.isSafeInteger(end) && end >= start ? { kind: 'bounded', start, end } : { kind: 'invalid' };
}

/**
 * The `Range` header to ask R2 for, re-serialised from the parse above so that the bytes
 * served are decided in exactly one place: `fetch` has already rejected a span this Worker
 * cannot serve, R2 is asked for the span that remains, and `servedRange` below checks that
 * it honoured the request.
 *
 * R2's typed `R2Range` form is deliberately not used, because a range it cannot satisfy
 * throws instead of degrading: the outcome would then depend on matching an error string.
 * The `Range` header form is not a safe fallback either — the deployed bucket throws for
 * exactly the same spans (`get: The requested range is not satisfiable (10039)`), which is
 * what answered `500` / `error code: 1101` without a CORS grant before `fetch` started
 * validating the span against object metadata first. The local simulator is the lenient
 * one: it serves the whole object, which is why `servedRange` still verifies the offset R2
 * reports.
 */
function rangeHeader(requested: RequestedRange): Headers | undefined {
  switch (requested.kind) {
    case 'bounded': return new Headers({ Range: `bytes=${requested.start}-${requested.end}` });
    case 'open': return new Headers({ Range: `bytes=${requested.start}-` });
    case 'suffix': return new Headers({ Range: `bytes=-${requested.length}` });
    default: return undefined;
  }
}

/**
 * Normalises the range R2 reports into an absolute offset and length. R2 answers a
 * suffix request already resolved, and its objects carry `offset`, `length` and
 * `suffix` as three own properties with the unused ones `undefined`, so the declared
 * union cannot be discriminated with `in` — the values have to be read.
 */
function normaliseRange(range: R2Range, size: number): ServedRange | null {
  const reported: { offset?: number; length?: number; suffix?: number } = range;
  if (typeof reported.suffix === 'number') {
    const length = Math.min(reported.suffix, size);
    return Number.isSafeInteger(length) && length > 0 ? { offset: size - length, length } : null;
  }
  const offset = reported.offset;
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) return null;
  const length = typeof reported.length === 'number' ? reported.length : size - offset;
  return Number.isSafeInteger(length) && length > 0 ? { offset, length } : null;
}

/**
 * Reads back what R2 served and rejects anything that is not the requested span, so
 * `Content-Range` can never describe bytes the body does not contain. R2 reports the
 * suffix form already resolved to an absolute offset, and clamps an end past EOF, so
 * the offset and length are R2's, not ours.
 */
function servedRange(object: R2ObjectBody, requested: RequestedRange): ServedRange | null {
  if (requested.kind === 'none') return { offset: 0, length: object.size };
  if (object.size === 0 || object.range === undefined) return null;
  const served = normaliseRange(object.range, object.size);
  if (served === null || served.offset + served.length > object.size) return null;
  switch (requested.kind) {
    case 'bounded':
    case 'open':
      // Asked for `bytes=<start>-...` and got a body that does not begin at `<start>`:
      // R2 ignored the range because it starts at or past EOF. Left unchecked this is
      // the one path that would return 206 while streaming the whole archive.
      return served.offset === requested.start ? served : null;
    case 'suffix':
      // R2 clamps a suffix longer than the object; a suffix it ignored would span the
      // whole object, which only matches a suffix of at least that length.
      return served.length === Math.min(requested.length, object.size) ? served : null;
    default:
      return null;
  }
}

/**
 * The size a satisfiable range resolves to: how a HEAD is answered without a body, and how
 * `fetch` rejects an unsatisfiable GET before R2 is asked for the span.
 */
function resolveAgainst(requested: RequestedRange, size: number): ServedRange | null {
  switch (requested.kind) {
    case 'none': return { offset: 0, length: size };
    case 'bounded':
      return requested.start < size
        ? { offset: requested.start, length: Math.min(requested.end, size - 1) - requested.start + 1 }
        : null;
    case 'open': return requested.start < size ? { offset: requested.start, length: size - requested.start } : null;
    case 'suffix': {
      if (size === 0) return null;
      const length = Math.min(requested.length, size);
      return length > 0 ? { offset: size - length, length } : null;
    }
    default: return null;
  }
}

/** Representation metadata, always copied from the R2 object rather than invented. */
function representation(object: R2Object, key: string): Headers {
  return new Headers({
    'Content-Type': key.endsWith('.json') ? 'application/json' : 'application/octet-stream',
    'ETag': object.httpEtag,
    'Last-Modified': object.uploaded.toUTCString(),
    'Cache-Control': IMMUTABLE,
    'Accept-Ranges': 'bytes',
    ...CORS,
  });
}

function problem(message: string, status: number, extra?: Record<string, string>): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...CORS, ...extra },
  });
}

/**
 * A preflight is answered from constants alone — no R2 lookup, no range parse. The requested
 * headers are echoed when the browser names them, so a future store that adds a request header
 * does not need a Worker change; the fallback covers a preflight that names none.
 */
function preflight(request: Request): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS,
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') ?? PREFLIGHT_HEADERS,
      'Access-Control-Max-Age': '86400',
    },
  });
}

/** 416 must say how long the representation is, or the client cannot retry. */
function unsatisfiable(size: number): Response {
  return problem('Requested range is not satisfiable.', 416, { 'Content-Range': `bytes */${size}` });
}

/**
 * Maps the request path to an R2 key. The decoded form is validated so that an
 * encoded separator cannot smuggle a `..` segment past the check, while the key
 * itself keeps the path exactly as the manifest declared it — for this release's
 * layout (`[a-z0-9.-]` plus `/`) the two forms are identical.
 */
function objectKey(pathname: string): string | null {
  const key = pathname.slice(PREFIX.length);
  if (key === '') return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(key);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  return decoded.split('/').some(segment => segment === '' || segment === '.' || segment === '..') ? null : key;
}

export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(PREFIX)) return env.ASSETS.fetch(request);
    if (request.method === 'OPTIONS') return preflight(request);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return problem('Method not allowed.', 405, { Allow: 'GET, HEAD' });
    }

    const key = objectKey(url.pathname);
    if (key === null) return problem('Invalid object key.', 404);

    const requested = parseRange(request.headers.get('Range'));

    // HEAD is answered from object metadata alone: no body stream is ever opened and
    // no byte of the archive is read.
    if (request.method === 'HEAD') {
      const object = await env.GRAPH.head(key);
      if (object === null) return problem('Expected graph object is missing.', 404);
      const served = resolveAgainst(requested, object.size);
      if (served === null) return unsatisfiable(object.size);
      const headers = representation(object, key);
      headers.set('Content-Length', String(served.length));
      if (requested.kind === 'none') return new Response(null, { status: 200, headers });
      headers.set('Content-Range', `bytes ${served.offset}-${served.offset + served.length - 1}/${object.size}`);
      return new Response(null, { status: 206, headers });
    }

    // A range this Worker cannot parse is resolved against metadata only, so a 416
    // never pulls the archive through the Worker to discover its size.
    if (requested.kind === 'invalid') {
      const object = await env.GRAPH.head(key);
      if (object === null) return problem('Expected graph object is missing.', 404);
      return unsatisfiable(object.size);
    }

    // A span that starts at or past EOF must be answered here, not by R2: the deployed
    // binding throws for a range it cannot satisfy, and that throw is what reached the
    // client as a 500 with no CORS grant. Only the two shapes whose satisfiability depends
    // on the object's size pay for the lookup — a `none` request has no span to check, and
    // a suffix range is one R2 resolves (and clamps) itself — so a whole-object read still
    // costs a single R2 operation.
    if (requested.kind === 'bounded' || requested.kind === 'open') {
      const metadata = await env.GRAPH.head(key);
      if (metadata === null) return problem('Expected graph object is missing.', 404);
      if (resolveAgainst(requested, metadata.size) === null) return unsatisfiable(metadata.size);
    }

    const object = await env.GRAPH.get(key, requested.kind === 'none' ? undefined : { range: rangeHeader(requested) });
    if (object === null) return problem('Expected graph object is missing.', 404);

    const served = servedRange(object, requested);
    if (served === null) {
      await object.body.cancel().catch(() => {});
      return unsatisfiable(object.size);
    }

    const headers = representation(object, key);
    headers.set('Content-Length', String(served.length));
    if (requested.kind === 'none') return new Response(object.body, { status: 200, headers });
    headers.set('Content-Range', `bytes ${served.offset}-${served.offset + served.length - 1}/${object.size}`);
    return new Response(object.body, { status: 206, headers });
  },
};
