# Publication — indonesia-260926-eab7ae90e4197185

The release is live on the Worker and in R2. Three objects are published for v1: the archive, its
runtime configuration, and — last, after the corpus gate — the delivery manifest.

- Worker: `https://valhalla-route-id.gislabs.workers.dev` (version `188c533e-b3b3-453d-944c-1e1ae93f9073`,
  deployed 2026-09-28T05:44:20Z, 37 assets, `Total Upload: 6.60 KiB`, bindings `env.GRAPH`
  (`valhalla-route-id-graph`) and `env.ASSETS`)
- Bucket: `valhalla-route-id-graph`, created 2026-09-28T05:44:00Z, location APAC, Standard class
- Delivery manifest: `build/hosting/indonesia-260926-eab7ae90e4197185-manifest.json`, 1,477,817 bytes,
  written by `tools/publish/manifest-etags.mjs` and uploaded last

## Published objects

| Key (`<release>/…`) | Bytes | Content-Type | ETag | Uploaded | Upload |
| --- | --- | --- | --- | --- | --- |
| `graph.tar` | 2,041,282,560 | `application/octet-stream` | `"8577eb86b61c7041ea07caf5cdd08c98-122"` | 05:53:16Z | 196.5 s (122 × 16 MiB parts) |
| `config.json` | 9,438 | `application/json` | `"3eea0b20078c2c10165ebdcfdd9c3189"` | 05:47:19Z | 2 s |
| `manifest.json` | 1,477,817 | `application/json` | `"25bc7249dfaeebeeb3f3da0a221db255"` | 05:55:04Z | 4 s |

The `config.json` ETag is the MD5 of the released file (`md5 -q config.json` =
`3eea0b20078c2c10165ebdcfdd9c3189`), so the deployed object is byte-identical to the release, and
its SHA-256 (`469b8525…`) equals `manifest.config.sha256`. The archive's ETag is R2's multipart
form: it is quoted and strong, which is all the loader requires, and every read is additionally
validated against the tile's `sha256`.

### Keys have no `datasets/` prefix

The R2 keys are `<release>/<object>`. The URL prefix `/datasets/` is the Worker's route, not part of
the key: `worker/index.ts` strips `PREFIX = '/datasets/'` before `env.GRAPH.head/get`, and
`worker/index.test.ts` stores objects under exactly that shape (`origin = key =>
https://example.com/datasets/${key}`). The plan's `wrangler r2 object put
"valhalla-route-id-graph/datasets/$RELEASE/graph.tar"` form therefore uploads objects the Worker
can never find — the first `config.json` upload was made that way, HEADed `404`, and was deleted and
re-uploaded under the correct key.

### Large objects cannot go through Wrangler

`wrangler r2 object put --remote` refuses anything over 300 MiB (`MAX_UPLOAD_SIZE_BYTES` in
Wrangler 4.141.0) and has no multipart path; the Cloudflare REST upload endpoint is capped at 300 MB
as well. The 1.9 GiB archive was therefore pushed through a throwaway Worker with an R2 binding
(`createMultipartUpload` / `resumeMultipartUpload().uploadPart()` / `complete()`), 122 parts of
16 MiB at concurrency 3, to the same bucket the production Worker reads. That Worker was deployed
under a different name with a random upload token and deleted as soon as the last upload finished;
the bucket now holds exactly the three objects above.

## Corpus gate

The manifest was held back until the re-run of the native-versus-WASM corpus finished. Its log ends:

```
16 cases: 14 identical, 2 different
  of the differing: 0 explained by SDK request normalisation, 0 genuine engine disagreement(s), 2 SDK-level gate(s)
  0 verified disagreement(s) (0 reproduced byte-for-byte on the rewritten request; 2 unverified — 2 with no engine answer).
report: docs/datasets/indonesia-260926-eab7ae90e4197185-verification.md
SDK-gated (no native code) cases: jakarta-bandung-bicycle, jakarta-bandung-pedestrian
CORPUS_EXIT=1
```

`CORPUS_EXIT=1` is the runner's exit code for *any* difference, including a case the SDK host
stopped before the engine answered, which is what the two here are (`sdkError TIMEOUT`, no engine
answer to compare, so `classifyDifferences` counts them as SDK-level gates rather than as engine
disagreements). The publication criterion — zero verified engine/loader disagreements and no
unclassified rows — holds: the same run reports **0 verified disagreements** and **0 unclassified**,
and the regenerated report states that the two engines agreed byte-for-byte on every request they
were both given. The two timeouts are the known runtime limitation recorded in
`docs/datasets/indonesia-260926-eab7ae90e4197185.md` (bicycle and pedestrian on this WASM build;
the app must not ship them without addressing it).

## Deployed verification

`node --import ./tools/publish/client-cache.mjs tools/publish/verify-deployed.mjs --manifest-url
https://valhalla-route-id.gislabs.workers.dev/datasets/indonesia-260926-eab7ae90e4197185/manifest.json`
(exit 0):

```
(a) HEAD 200
    content-length: 2041282560
    content-range: (absent)
    content-encoding: (absent)
    etag: "8577eb86b61c7041ea07caf5cdd08c98-122"
    last-modified: Mon, 28 Sep 2026 05:53:16 GMT
    accept-ranges: bytes
    cache-control: public, max-age=31536000, immutable
    HEAD with a browser's Accept-Encoding: 200, content-length 2041282560, content-encoding (absent), etag "8577eb86b61c7041ea07caf5cdd08c98-122"

(b) Range bytes=1000000000-1000010239
    content-length: 10240
    content-range: bytes 1000000000-1000010239/2041282560
    content-encoding: (absent)
    etag: "8577eb86b61c7041ea07caf5cdd08c98-122"
    body 10240 bytes, sha256 7ba34c0a5d613274c28679e32e4836bc64abed299400bad248aefe175a98e9c5
    local public/datasets/indonesia-260926-eab7ae90e4197185/graph.tar bytes 1000000000-1000010239, sha256 7ba34c0a5d613274c28679e32e4836bc64abed299400bad248aefe175a98e9c5

(b) Range bytes=1900000000-1900010239
    content-length: 10240
    content-range: bytes 1900000000-1900010239/2041282560
    content-encoding: (absent)
    etag: "8577eb86b61c7041ea07caf5cdd08c98-122"
    body 10240 bytes, sha256 72d18edbc7753deb959f5e3059b30c78d8431a6a5bbf46c12b33ac2f26831ec5
    local public/datasets/indonesia-260926-eab7ae90e4197185/graph.tar bytes 1900000000-1900010239, sha256 72d18edbc7753deb959f5e3059b30c78d8431a6a5bbf46c12b33ac2f26831ec5

(c) SDK route -6.1754,106.8272 -> -6.9175,107.6191, costing auto
    startup release indonesia-260926-eab7ae90e4197185, memoryBudgetBytes 100663296, supportedCostings auto, motorcycle, motor_scooter, truck, bicycle, pedestrian
    startup bytes 1656951 over 6 requests, config sha256 469b8525ae51464bb04ca675308060efc64bf804149cb4914b749c04daa965ee
    distance 156.305 km, duration 7003.278 s, cost 8187.584
    routeMs 54729.6 ms, hostRouteMs 54730.5 ms, decodedCacheHits 221349, wall 54.7 s
    bytes validated 93674863856 over 4650 requests (4650 tile downloads, 0 metadata bytes, 0 retries, deduplicated 0), 50.8 s in download waits
    corpus native reference (jakarta-bandung-auto): byte-identical (31549 vs 31549 bytes, canonical JSON)
    corpus recorded SDK answer (jakarta-bandung-auto): byte-identical (31549 vs 31549 bytes, canonical JSON)
    client cache: 2 origin responses (0.0 MiB) for 21 distinct ranges, 4657 local hits (89338.3 MiB re-read and re-validated)

OK: the deployed origin served the released archive and routed a real request.
```

The startup bytes are exactly the delivered metadata: the 1,477,817-byte delivery manifest, the
9,438-byte config and the 169,696-byte archive header/index, all read through the SDK's loader from
the deployed origin. The route's answer is byte-identical — after the corpus's own canonicalisation
of `55.0` versus `55` — to both the pinned native reference and the recorded SDK half of the corpus.

## What the end-to-end route measured

The route is not cheap, and the numbers are worth carrying forward:

- 4,650 tile reads, **93.6 GB validated**, per Jakarta→Bandung `auto` route, covering only
  **18 distinct byte ranges** (207 MiB). The engine re-reads the same large Jakarta tiles thousands
  of times because the SDK caps the decoded-tile cache at `memoryBudgetBytes` while the two largest
  tiles are 48.4 MB and 37.4 MB.
- The SDK's loader keeps no tile bytes, so without a cache each of those re-reads is a fresh
  download; the route cannot finish inside the host's 300 s maximum over a WAN, and on a slow link
  even the first read of the 48.4 MB tile takes longer than the loader's maximum 60 s per-request
  timeout (measured: 79.1 s and 101.5 s at 0.5–0.6 MB/s). Set `timeoutMs` explicitly for any
  non-localhost client; the 10 s default fails immediately on these tiles.
- A browser client is in a better position than a Node one: the Worker serves every dataset object
  with `Cache-Control: public, max-age=31536000, immutable`, so the 18 distinct ranges are fetched
  once. The run above used that same semantic through `tools/publish/client-cache.mjs`, and a cold
  cache is what fetches the 207 MiB.
- Even with a warm cache the route spends ~50–260 s re-reading and re-validating 93.6 GB of tile
  bytes (sha256 on every read), against the host's 300 s maximum. That is the margin the app has to
  plan around; the corpus's own numbers (85 s locally on the same graph) show it is decode/read
  pressure, not routing.

## Reproducing

```bash
node tools/publish/manifest-etags.mjs --release indonesia-260926-eab7ae90e4197185 \
  --base-url https://valhalla-route-id.gislabs.workers.dev/datasets/indonesia-260926-eab7ae90e4197185/ \
  --output build/hosting/indonesia-260926-eab7ae90e4197185-manifest.json      # fails if an object is missing or changed
npx wrangler r2 object put --remote valhalla-route-id-graph/indonesia-260926-eab7ae90e4197185/manifest.json \
  --file build/hosting/indonesia-260926-eab7ae90e4197185-manifest.json --content-type application/json
node --import ./tools/publish/client-cache.mjs tools/publish/verify-deployed.mjs \
  --manifest-url https://valhalla-route-id.gislabs.workers.dev/datasets/indonesia-260926-eab7ae90e4197185/manifest.json
```

The delivery manifest is uploaded **last**: until it exists the release is not live, and replacing
it is the only step needed to withdraw or correct a publication.
