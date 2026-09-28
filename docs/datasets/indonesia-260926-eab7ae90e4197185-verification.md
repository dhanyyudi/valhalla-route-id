# Verification — indonesia-260926-eab7ae90e4197185

Native-versus-WASM comparison of 16 requests on the published Indonesia graph:
**14 identical, 2 different** (exit code 1).

## What was compared

- Corpus: `tools/verify/corpus.jsonl` (16 pure Valhalla requests, sha256 `94dd5ec6eb9c`),
  case names in `tools/verify/corpus-names.json` (sidecar alignment asserted at runtime).
- Alignment: the halves are lined up by index, so each recorded output is stamped with the
  corpus sha256 it answers (`tools/verify/provenance.json`, written by `compare.mjs` for the
  half it runs and by `tools/verify/stamp.mjs` for the native half) and the runner refuses to
  compare a pair whose stamp does not match the committed corpus. Native half stamped
  `94dd5ec6eb9c`; this half is stamped as it is written.
- Native half: the pinned `native-reference` binary (`native/reference.cpp`) inside the
  `valhalla-browser-build:latest` image, reading the build work directory tiles:
  `docker run --rm --user 1000:1000 -v "$PWD:/work" -w /work valhalla-browser-build \`
  `build/native/native-reference build/osm-2h8ekft8/native-config.json tools/verify/corpus.jsonl`.
  Output `tools/verify/native.jsonl` (16 lines, sha256 `6a2d38b8aef7`).
- WASM half: `indonesia-260926-eab7ae90e4197185` served by `tools/serve-dataset.mjs` on port 8790 and routed through
  `valhalla-server/node` with `transport: "indexed-tar"`,
  `memoryBudgetBytes: 100663296` (96 MiB — the largest tile in this release is 48,442,160 B,
  and the SDK default of 32 MiB refuses to initialize against this dataset at all) and
  `routeTimeoutMs: 300000`. Output `tools/verify/wasm.jsonl` (sha256 `b2176518ea27`).
  Routing the 16 cases took 1348.7 s of WASM wall time.
  Startup identity: release `indonesia-260926-eab7ae90e4197185`, costings `auto, motorcycle, motor_scooter, truck, bicycle, pedestrian`,
  `memoryBudgetBytes` 100663296, WASM memory 256/512 MiB,
  config sha256 `469b8525ae51`, effective config sha256 `3307111ce482`.
- SDK build: `pnpm run build:sdk` was re-run after `packages/valhalla-core/src/profiles.ts` stopped
  forcing `radius`/`minimum_reachability` onto every location, so this run measures the fixed host
  (a first attempt against the stale `dist` bundle still reproduced the old forced-default answers).
- Native graph audit (`native-reference <config> --inspect`): `{"tiles":5271,"nodes":10329891,"nodesWithTimezone":10329891,"nodesWithCountry":10324197}`.

### The equality rule

Both sides are serialised with `JSON.stringify` of the parsed response and compared as text.
The comparison does **not** sort or reorder keys, does not touch numbers, and does not drop
fields; a route that differs by one manoeuvre, one coordinate in the encoded shape, or one
cost is a difference. The only normalisations are:

1. a failure becomes `{"nativeError":N}` on both sides — the SDK throws a `RoutingError`
   carrying the same Valhalla code in `nativeCode`, and an SDK-level failure with no native
   code is reported as `sdkError` instead, never as agreement; and
2. numerically equal numbers may be spelled differently (`0.0` natively, `0` in JavaScript).
   1 of 16 raw native lines already equalled their canonical form.

For example, the raw native line and its canonical form first diverge here:

```
native raw: …efore":117,"bearing_after":111,"time":55.0,"length":0.735,"cost":78.736,"begin_s…
canonical:  …efore":117,"bearing_after":111,"time":55,"length":0.735,"cost":78.736,"begin_sha…
```

### Expected non-zero outcomes

A case where both engines refuse to route is agreement, not a failure: the corpus deliberately
includes pairs that may have no road connection. Both sides reporting `nativeError` is a pass;
only a disagreement is a difference. This run had 1 case(s) where native reported an error.

### Why the differing cases differ

Of 2 differing case(s): 0 verified disagreement(s) (0 reproduced byte-for-byte on the rewritten request; 2 unverified — 2 with no engine answer).

- 0 are explained by the SDK rewriting the request. The SDK host
  (`packages/valhalla-core/src/profiles.ts`) resolves the costing, pins `units` to kilometres
  and resolves the language before the WASM engine sees it — and, since the correlation-default fix,
  leaves each location's `radius` and `minimum_reachability` exactly as the caller sent them,
  so native's own correlation defaults apply. `tools/verify/native-sdk-normalised.jsonl` records the pinned native
  binary's answers to those same rewritten requests (generated from `tools/verify/corpus-sdk-normalised.jsonl`);
  for such a case the native answer for the rewritten request is byte-identical to the WASM
  answer, so the engines agree and only the request differs.
- 0 remain genuine engine/loader disagreements — the two engines agreed byte-for-byte on every request they were both given. Any such case would block publication.
- 2 are SDK-level failures with no engine answer at all (a host gate such as the
  operation deadline or a resource limit), reported as `sdkError` rather than as agreement.

## Per-case results

| # | Case | Native | WASM | Verdict |
| --- | --- | --- | --- | --- |
| 1 | `jakarta-bandung-auto` | status 0: 156.305 km, 7003.278 s, cost 8187.584, 37 maneuvers, polyline shape 9812 chars | status 0: 156.305 km, 7003.278 s, cost 8187.584, 37 maneuvers, polyline shape 9812 chars | identical `9d4f7d8ce713` |
| 2 | `jakarta-bandung-motorcycle` | status 0: 168.149 km, 8285.622 s, cost 10132.827, 42 maneuvers, polyline shape 23644 chars | status 0: 168.149 km, 8285.622 s, cost 10132.827, 42 maneuvers, polyline shape 23644 chars | identical `8439efddf5d0` |
| 3 | `jakarta-bandung-motor-scooter` | status 0: 171.053 km, 13999.013 s, cost 39096.152, 60 maneuvers, polyline shape 25513 chars | status 0: 171.053 km, 13999.013 s, cost 39096.152, 60 maneuvers, polyline shape 25513 chars | identical `e752ebc19c8e` |
| 4 | `jakarta-bandung-bicycle` | status 0: 165.513 km, 34242.867 s, cost 82983.429, 233 maneuvers, polyline shape 28276 chars | sdkError TIMEOUT | **different** at byte 2 |
| 5 | `jakarta-bandung-pedestrian` | status 0: 155.798 km, 110106.476 s, cost 110560.007, 143 maneuvers, polyline shape 23003 chars | sdkError TIMEOUT | **different** at byte 2 |
| 6 | `surabaya-malang-truck` | status 0: 97.2 km, 4034.695 s, cost 7926.61, 31 maneuvers, polyline shape 6822 chars | status 0: 97.2 km, 4034.695 s, cost 7926.61, 31 maneuvers, polyline shape 6822 chars | identical `554781dde735` |
| 7 | `merak-bakauheni-ferry` | status 0: 30.295 km, 3990.311 s, cost 4183.398, 10 maneuvers, polyline shape 243 chars | status 0: 30.295 km, 3990.311 s, cost 4183.398, 10 maneuvers, polyline shape 243 chars | identical `d502aa863043` |
| 8 | `denpasar-loop-motorcycle` | nativeError 154 | nativeError 154 | identical `c37e86809466` |
| 9 | `depart-0700` | status 0: 156.305 km, 7003.267 s, cost 8187.566, 37 maneuvers, polyline shape 9812 chars | status 0: 156.305 km, 7003.267 s, cost 8187.566, 37 maneuvers, polyline shape 9812 chars | identical `d50a30731e60` |
| 10 | `arrive-1700` | status 0: 156.305 km, 7003.259 s, cost 8187.567, 37 maneuvers, polyline shape 9812 chars | status 0: 156.305 km, 7003.259 s, cost 8187.567, 37 maneuvers, polyline shape 9812 chars | identical `3486ebeb49f1` |
| 11 | `no-tolls` | status 0: 183.775 km, 9927.479 s, cost 13750.884, 58 maneuvers, polyline shape 27658 chars | status 0: 183.775 km, 9927.479 s, cost 13750.884, 58 maneuvers, polyline shape 27658 chars | identical `0e50e411eccf` |
| 12 | `waypoints-three` | status 0: 825.817 km, 33400.401 s, cost 35398.803, 82 maneuvers, polyline shape 50916 chars | status 0: 825.817 km, 33400.401 s, cost 35398.803, 82 maneuvers, polyline shape 50916 chars | identical `c21c7d29a340` |
| 13 | `shape-geojson` | status 0: 156.305 km, 7003.278 s, cost 8187.584, 37 maneuvers, polyline shape 9812 chars | status 0: 156.305 km, 7003.278 s, cost 8187.584, 37 maneuvers, polyline shape 9812 chars | identical `9d4f7d8ce713` |
| 14 | `preferred-side-opposite` | status 0: 156.305 km, 7003.278 s, cost 8187.584, 37 maneuvers, polyline shape 9812 chars | status 0: 156.305 km, 7003.278 s, cost 8187.584, 37 maneuvers, polyline shape 9812 chars | identical `9d4f7d8ce713` |
| 15 | `outside-coverage` | status 0: 1525.91 km, 90521.343 s, cost 87130.148, 42 maneuvers, polyline shape 77089 chars | status 0: 1525.91 km, 90521.343 s, cost 87130.148, 42 maneuvers, polyline shape 77089 chars | identical `5d88c066fd21` |
| 16 | `disconnected-island` | status 0: 1890.833 km, 76989.656 s, cost 71733.101, 63 maneuvers, polyline shape 116453 chars | status 0: 1890.833 km, 76989.656 s, cost 71733.101, 63 maneuvers, polyline shape 116453 chars | identical `1a675d117767` |

## Field findings

These cases exist to settle whether `shape_format` and `preferred_side` are accepted, and what
they actually do. "Effect on the response" compares the case against the plain `auto` request
(`jakarta-bandung-auto`) on the same coordinates, using the native output.

| Case | Field | Effect on the response |
| --- | --- | --- |
| — | `shape_format: "geojson"` — in Valhalla 3.8.3 only the matrix and OSRM serializers consult this option, not the trip serializer | accepted by both engines, byte-identical response to the plain `auto` case — no effect here |
| — | `preferred_side: "opposite"` on the origin — honoured by loki's side filter when the snapped edge has a side of street | accepted by both engines, byte-identical response to the plain `auto` case — no effect here |
| — | `costing_options.auto.use_tolls: 0, use_highways: 0.2` | accepted by both engines, response differs from the plain `auto` case |
| — | `date_time.type: 1` (depart at 2026-09-28T07:00) | accepted by both engines, response differs from the plain `auto` case |
| — | `date_time.type: 2` (arrive by 2026-09-28T17:00) | accepted by both engines, response differs from the plain `auto` case |

## Differences

### `jakarta-bandung-bicycle`

Request: `{"locations":[{"lat":-6.1754,"lon":106.8272},{"lat":-6.9175,"lon":107.6191}],"costing":"bicycle","directions_options":{"language":"en-US"}}`

```
native: {"trip":{"locations":[{"type":"break","lat":-6.1754,"lon":106.8272,"original_index":0},{"type":"break","lat":-6.9175,"lon"…
wasm:   {"sdkError":{"code":"TIMEOUT","message":"Routing operation deadline expired."}}
```

- native: status 0: 165.513 km, 34242.867 s, cost 82983.429, 233 maneuvers, polyline shape 28276 chars
- wasm:   sdkError TIMEOUT — TIMEOUT: Routing operation deadline expired.
- first differing byte: 2 (native 147783 bytes, wasm 79 bytes)
- SDK-normalisation control: not applicable — the WASM half produced no engine answer at all
  (the SDK host stopped the operation before the engine returned), so there is nothing to
  compare against the rewritten request.
- Deadline-lifted engine run: not recorded for this case.

### `jakarta-bandung-pedestrian`

Request: `{"locations":[{"lat":-6.1754,"lon":106.8272},{"lat":-6.9175,"lon":107.6191}],"costing":"pedestrian","directions_options":{"language":"en-US"}}`

```
native: {"trip":{"locations":[{"type":"break","lat":-6.1754,"lon":106.8272,"original_index":0},{"type":"break","lat":-6.9175,"lon"…
wasm:   {"sdkError":{"code":"TIMEOUT","message":"Routing operation deadline expired."}}
```

- native: status 0: 155.798 km, 110106.476 s, cost 110560.007, 143 maneuvers, polyline shape 23003 chars
- wasm:   sdkError TIMEOUT — TIMEOUT: Routing operation deadline expired.
- first differing byte: 2 (native 94626 bytes, wasm 79 bytes)
- SDK-normalisation control: not applicable — the WASM half produced no engine answer at all
  (the SDK host stopped the operation before the engine returned), so there is nothing to
  compare against the rewritten request.
- Deadline-lifted engine run: not recorded for this case.

## Limitations

- Every corpus request pins `directions_options.language` to `en-US`. Native Valhalla only
  accepts a language it has a compiled locale for; this fork's SDK host otherwise sends
  `id-ID` (`packages/valhalla-core/src/profiles.ts`), and the WASM runtime in this release ships
  only the `en-US` locale, so the SDK default silently falls back to English. The corpus pins
  the language explicitly instead of relying on that fallback; the pin is inert today, and
  Indonesian narration is not available from this runtime build at all.
- A handful of long-distance routes share one WASM session, so tile-cache state differs from a
  cold single-request run. Routing output does not depend on cache state; only timing does.
- The WASM half measures the **packaged** SDK (`packages/valhalla-server/dist`, bundled from
  `packages/valhalla-core/src`), not the TypeScript sources. `pnpm run build:sdk` must be re-run
  before this corpus whenever the core changes, or the comparison silently measures the
  previous build — which is how the first attempt at this re-run still saw the old forced
  correlation defaults after `profiles.ts` had been fixed.
- This is a `route` action corpus. `isochrone`, `optimized_route` and `matrix` are exported by
  the runtime but are not covered here.

Generated 2026-09-28T05:53:21Z by `node tools/verify/compare.mjs indonesia-260926-eab7ae90e4197185`.

