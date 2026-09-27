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
2. `packages/valhalla-core/src/types.ts` — extended request/result types.
3. `native/runtime.cpp` + `native/CMakeLists.txt` — three added exports:
   `vb_isochrone`, `vb_optimized_route`, `vb_matrix`.
4. `packages/valhalla-core/src/engine.ts` and both adapters — matching methods.
5. `tools/smoke/route-smoke.test.ts` — two behaviours of the pinned fixture that the plan's cases
   could not assert as written. The Liechtenstein release offers no alternative path for the
   Vaduz→Malbun smoke leg, so native omits `alternates` from the route response instead of
   returning an empty array; that case asserts the documented
   `alternates === undefined || Array.isArray(alternates)` fallback and still requires a non-empty
   primary trip. The same release declares only `auto`, `bicycle`, `pedestrian` and `truck`
   (vendored `scripts/prepare-data.py`), so it refuses `motor_scooter` with `UNSUPPORTED_COSTING`
   before native routing; the suite pins that refusal and proves distinct-profile routing with
   `bicycle` instead. Both were observed against `liechtenstein-2015-v1-d769cb7c11b2936d`, never
   worked around.

## Rebasing on a newer upstream release

    git clone https://github.com/tobilg/valhalla-wasm /tmp/valhalla-wasm-next
    git -C /tmp/valhalla-wasm-next checkout <new tag>
    # re-copy the same paths, then re-apply the four divergences above
    pnpm install && pnpm test && pnpm run build:sdk && pnpm run smoke

Never take a new upstream release without rebuilding the Indonesia dataset with
its pinned Valhalla revision.

## WASM runtime artifacts

The pinned runtime is published as the GitHub release **`wasm-runtime-v1`**
(https://github.com/dhanyyudi/valhalla-route-id/releases/tag/wasm-runtime-v1).
CI downloads it before packaging the SDK, because CI has no Docker.

| artifact | bytes | sha256 |
| --- | --- | --- |
| `valhalla.wasm` | 9,861,835 | `2097e57700e51bc703da06ecd74fb2edf656b58173e51488a3cdc9ffe0cc0db1` |
| `valhalla.js` | 116,584 | `fabe0f4830ab5bbde355c9ebc749b4b5dc83bffb05930080bf6f3d74961fa2bb` |

`native/runtime-lock.json` records the same hashes. A rebuild that changes them must update
both the lockfile and this release (`gh release upload wasm-runtime-v1 ... --clobber`), and
re-run the verification corpus before publishing graph data built with the new runtime.
