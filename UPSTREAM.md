# Upstream provenance

Vendored from https://github.com/tobilg/valhalla-wasm at tag `v0.2.1`
(commit `b09d0ceb6673801d9e8eeb30c43927b89300c553`), MIT licensed. Upstream pins Valhalla
3.8.3 revision `a60c7cbfc83e073f50887cd27e0109d02e6b64e5` in `versions.json`;
tiles must be built with that revision.

Copied: `packages/valhalla-core`, `packages/valhalla-browser`,
`packages/valhalla-server`, `native/`, `scripts/`, `patches/`, `versions.json`,
`LICENSE` (relocated to `third_party/valhalla-wasm/LICENSE`), `NOTICE.md`, and the upstream lockfile as `pnpm-lock.upstream.yaml`.

## Intentional divergences

1. `packages/valhalla-core/src/profiles.ts` — validator accepts six costings,
   N locations, the full per-profile costing option sets, `date_time`,
   `alternates`, `exclude_polygons`, `shape_format`, `directions_options`,
   and preserves unknown top-level fields with warnings instead of dropping them.
   `validateRequest(request, { minimumLocations })` lowers the location floor for the
   single-center and one-sided tools, and a request carrying `sources`/`targets` is validated as a
   matrix: both sides are required, their combined size is the location count used for coverage,
   and the documented tool fields (`contours`, `polygons`, `denoise`, `generalize`,
   `show_locations`) no longer register as unknown fields. Upstream also wrote
   `radius: 30, minimum_reachability: 0` onto **every** location; this fork no longer forces either
   field. They are forwarded only when the caller sent them (validated as finite, non-negative
   numbers), so native's own correlation defaults apply — `minimum_reachability: 50` in this
   project's pinned configs — and a caller that wants a value can still set it deliberately. The
   forced values were not harmless: they moved three of the sixteen native-versus-WASM corpus
   answers, one of them from a route to `NO_ROUTE` (Task 8 review fix 2; see
   `docs/datasets/indonesia-260926-eab7ae90e4197185-verification.md`).
2. `packages/valhalla-core/src/types.ts` — extended request/result types, including
   `IsochroneRequest` and `MatrixRequest`.
3. `native/runtime.cpp` + `native/CMakeLists.txt` — three added exports:
   `vb_isochrone`, `vb_optimized_route`, `vb_matrix`. Every export now shares one
   `call_actor` helper, which has to stay outside the `extern "C"` block because a template
   cannot carry C language linkage. `vb_route` results are byte-identical to the published
   `wasm-runtime-v1` runtime for eight route scenarios (see the verification note below).
4. `packages/valhalla-core/src/engine.ts` and both adapters — matching methods. The engine also
   points `max_reserved_labels_count_dijkstras` and `max_reserved_labels_count_bidir_dijkstras`
   at the resolved search-memory policy, alongside the two A* keys upstream already overrode.
   The pinned dataset reserves 4,000,000 and 2,000,000 labels per location on those keys, which
   made `matrix` and `optimized_route` exhaust the default 512 MiB ceiling with
   `runtimeError: MEMORY` (846 MiB high-water); with the shared policy all three tools fit the
   default 256 MiB initial heap.
5. `scripts/build-dataset.py` and `scripts/prepare-data.py` — both emit
   `['auto', 'motorcycle', 'motor_scooter', 'truck', 'bicycle', 'pedestrian']` instead of upstream's
   `['auto', 'bicycle', 'pedestrian', 'truck']`. The manifest's `costings` list is what the SDK
   validates a request against *before* it reaches the runtime, so a release built with the upstream
   list is unusable for `motorcycle` and `motor_scooter` however complete the tiles are. These two
   lines are the only costings edits this project carries; the tile builder itself is upstream's,
   rebuilt from the pinned revision, and its cache ceiling (divergence 6) is the only other builder
   change. Because `costings` participates in the release identity, the
   change renames every release built after it, and it changes what a *rebuilt* Liechtenstein
   fixture would declare (see divergence 7).
6. `scripts/build-dataset.py` — `max_cache_size` is raised from 32 MiB to 268435456 bytes (256 MiB),
   and only that value changes: `use_lru_mem_cache=True` and `lru_mem_cache_hard_control=True` stay as
   upstream wrote them. The 32 MiB ceiling was sized for the Liechtenstein fixture and is fatal for
   Indonesia: Valhalla's `TileCacheLRU::Put` refuses any tile larger than the ceiling with an
   **unconditional** `throw std::runtime_error("TileCacheLRU: tile size is bigger than max cache
   size")` (`src/baldr/graphreader.cc`, the LRU hard-control flag only selects trimming behaviour), so
   the tile builder aborted with `SIGABRT` a few minutes in, once `BuildLocalTiles` handed the cache
   the Jakarta level-2 tiles. Two are oversized — `tiles/2/000/483/547.gph` at 39,562,144 B (37.73
   MiB, Central/East Jakarta) and `tiles/2/000/482/107.gph` at 48,489,040 B (46.25 MiB, South
   Jakarta / Depok) — and the same two tiles exist in the production `20260927-2013_v3.9.0_osm260926`
   release built from the same extract, which is why that build succeeds with a different cache
   configuration. 256 MiB clears the largest observed tile with room for growth in the same
   0.25° cells. Note for consumers: the released `config.json` ships this value but
   `packages/valhalla-core/src/engine.ts` rewrites `max_cache_size` from the caller's
   `memoryBudgetBytes` at load time, so fetching those two tiles needs a budget above ~46.3 MiB
   (default 32 MiB, ceiling 128 MiB).
7. `tools/smoke/route-smoke.test.ts` — two behaviours of the pinned fixture that the plan's cases
   could not assert as written. The Liechtenstein release offers no alternative path for the
   Vaduz→Malbun smoke leg, so native omits `alternates` from the route response instead of
   returning an empty array; that case asserts the documented
   `alternates === undefined || Array.isArray(alternates)` fallback and still requires a non-empty
   primary trip. The same release declares only `auto`, `bicycle`, `pedestrian` and `truck`, because
   the published `liechtenstein-2015-v1-d769cb7c11b2936d` directory was built from `prepare-data.py`
   before divergence 5 and stays immutable, so it still refuses `motor_scooter` with
   `UNSUPPORTED_COSTING` before native routing; the suite pins that refusal and proves
   distinct-profile routing with `bicycle` instead. Re-running `pnpm run data:region` now emits a
   six-costing fixture under a new release name, at which point that refusal case must be revisited.
   Both behaviours were observed against `liechtenstein-2015-v1-d769cb7c11b2936d`, never worked
   around.
8. `tools/smoke/tools-smoke.test.ts` — the three new tools against the same fixture with `auto`,
   the only profile the release declares for them. The observed native shapes are asserted as
   they are: isochrone is a GeoJSON `FeatureCollection` (one `Polygon` feature per band with
   `polygons: true`, largest band first, `LineString` without it), `optimized_route` returns a
   `trip` with one location per stop and `locations - 1` legs, and `matrix` returns
   `sources_to_targets` with `algorithm: "costmatrix"`, `units: "kilometers"` and a zero diagonal.

## Rebasing on a newer upstream release

    git clone https://github.com/tobilg/valhalla-wasm /tmp/valhalla-wasm-next
    git -C /tmp/valhalla-wasm-next checkout <new tag>
    # re-copy the same paths, then re-apply the eight divergences above
    pnpm install && pnpm test && pnpm run build:sdk && pnpm run smoke

Never take a new upstream release without rebuilding the Indonesia dataset with
its pinned Valhalla revision.

## Verification notes

The shared `call_actor` refactor is behaviour-preserving. Eight route scenarios (two and three
locations, `auto`, `bicycle`, `pedestrian`, `truck`, a departure time, `alternates` and
`costing_options`) were captured against the published `wasm-runtime-v1` runtime
(`2097e577…`/`fabe0f48…`) and against the rebuilt runtime (`81d3d924…`/`f6038d92…`) over
`liechtenstein-2015-v1-d769cb7c11b2936d`; the two captures are byte-identical, and the five
`tools/smoke/route-smoke.test.ts` cases pass unchanged against the rebuild.

## WASM runtime artifacts

The pinned runtime is published as the GitHub release **`wasm-runtime-v1`**
(https://github.com/dhanyyudi/valhalla-route-id/releases/tag/wasm-runtime-v1).
CI downloads it before packaging the SDK, because CI has no Docker.

| artifact | bytes | sha256 |
| --- | --- | --- |
| `valhalla.wasm` | 10,109,445 | `81d3d9241c897d822a672eb962a4994cf03f79c7c1eb3377b999281bab404744` |
| `valhalla.js` | 117,879 | `f6038d92d60ba2850300c73c9b8a9f01062acdc81610a666f3b22ef85c0acbbe` |

These are the artifacts built from the three-export `runtime.cpp`. The release still carries the
previous pair (`2097e57700e51bc703da06ecd74fb2edf656b58173e51488a3cdc9ffe0cc0db1`,
`fabe0f4830ab5bbde355c9ebc749b4b5dc83bffb05930080bf6f3d74961fa2bb`), so it must be republished
before CI packages the SDK — packaging verifies the downloaded binary against
`native/runtime-lock.json` and fails on a mismatch.

`native/runtime-lock.json` records the same hashes. A rebuild that changes them must update
both the lockfile and this release (`gh release upload wasm-runtime-v1 valhalla.js valhalla.wasm --clobber`), and
re-run the verification corpus before publishing graph data built with the new runtime.
