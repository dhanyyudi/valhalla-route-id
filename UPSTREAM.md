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

## Rebasing on a newer upstream release

    git clone https://github.com/tobilg/valhalla-wasm /tmp/valhalla-wasm-next
    git -C /tmp/valhalla-wasm-next checkout <new tag>
    # re-copy the same paths, then re-apply the four divergences above
    pnpm install && pnpm test && pnpm run build:sdk && pnpm run smoke

Never take a new upstream release without rebuilding the Indonesia dataset with
its pinned Valhalla revision.
