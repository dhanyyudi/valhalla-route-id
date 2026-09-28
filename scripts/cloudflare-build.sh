#!/usr/bin/env bash
# Build command for Cloudflare Workers Builds (Git-connected auto deploy).
#
# The WASM runtime and its license texts are not committed: they come out of the pinned Docker build
# (`pnpm run build:wasm`) and are published as GitHub release assets, which `.github/workflows/ci.yml`
# fetches with `gh`. The Workers Builds image has no `gh` login, but the repository is public, so the
# same assets are fetched over plain HTTPS here. `pnpm run build:sdk` then re-checks the runtime
# against native/runtime-lock.json and fails on any mismatch, so a stale or altered asset cannot ship.
#
# Requires the build variable VITE_MANIFEST_URL: without it the SPA builds but cannot load a dataset.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${VITE_MANIFEST_URL:-}" ]; then
  echo "VITE_MANIFEST_URL is not set: add it under Settings → Build → Variables and secrets." >&2
  exit 1
fi

RELEASES="${VALHALLA_RELEASES_URL:-https://github.com/dhanyyudi/valhalla-route-id/releases/download}"

mkdir -p public/wasm
curl -fsSL --retry 3 -o public/wasm/valhalla.wasm "$RELEASES/wasm-runtime-v1/valhalla.wasm"
curl -fsSL --retry 3 -o public/wasm/valhalla.js "$RELEASES/wasm-runtime-v1/valhalla.js"
curl -fsSL --retry 3 "$RELEASES/ci-fixtures-v1/runtime-licenses.tar.gz" | tar xz -C public/wasm

pnpm run build:sdk
pnpm run build
