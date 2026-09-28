# Valhalla Route ID

A public **Valhalla routing inspector for Indonesia** that runs entirely in the browser. Valhalla
3.8.3 is compiled to WebAssembly; the country's road graph lives in Cloudflare R2 and is pulled on
demand as HTTP byte ranges. Place waypoints on the map, pick a vehicle and a departure or arrival
time, and inspect the route the engine actually returned — geometry, distance, duration and
turn-by-turn manoeuvres.

Nothing routes on a server. The app is a static bundle, and the only traffic leaving the browser is
the graph data it reads.

**Live:** <https://valhalla-route-id.gislabs.workers.dev>

## What it does

- Place two or more waypoints by clicking the map, or by pasting `lat, lon` pairs or a Google Maps
  link into the paste box.
- Route for `auto`, `motorcycle`, `motor_scooter`, `truck`, `bicycle` or `pedestrian`.
- Route now, depart at, or arrive by a time in the dataset's local time, with quick hour presets.
- Tune the costing options that profile exposes — top speed, highways, tolls, ferries, trails, and
  truck dimensions/weight/hazmat.
- Watch progress while tiles are read, cancel a long route, and then read the distance, duration,
  simulated departure/arrival time, dataset release, bytes fetched and decoded geometry from the
  status bar and the map.

## How it works

One Cloudflare Worker is the whole backend:

| Piece | Where it lives | Notes |
| --- | --- | --- |
| SPA | Worker static assets (`dist/`) | Vite + React + TypeScript + Tailwind v4 + MapLibre GL |
| Routing engine | `public/wasm/valhalla.wasm` (10,109,445 B) + `valhalla.js` glue | Valhalla 3.8.3 cross-compiled with Emscripten; runs in a Web Worker in the browser |
| Road graph | R2 bucket behind `/datasets/*` | `graph.tar` (2,041,282,560 B) split into 5,271 tiles; the Worker answers `Range` requests so a route downloads only the tiles it touches |
| SDK | `packages/valhalla-*` | A pinned fork of [`tobilg/valhalla-wasm`](https://github.com/tobilg/valhalla-wasm) 0.2.1 with its own request validator and a fetch-backed tile store |

The browser asks for the release manifest, learns every tile's offset, length and ETag, then reads
the byte ranges it needs straight out of the archive. Tiles are cached in memory for the session, so
the second route is much faster than the first.

The tile cache is explicitly budgeted: the app requests **96 MiB** (`memoryBudgetBytes`
100663296) because the largest tile in this release is 48,442,160 B. The SDK's 32 MiB default
refuses to initialise against this dataset at all.

## Run it locally

Requirements: Node.js ≥ 22.22.2, pnpm 12 (the version pinned in `package.json`), and the
[GitHub CLI](https://cli.github.com) to fetch the compiled runtime.

```bash
pnpm install

# The WASM runtime is not committed: it is the output of a pinned Docker build
# (`pnpm run build:wasm`) and is published as a release asset instead.
mkdir -p public/wasm
gh release download wasm-runtime-v1 --pattern valhalla.wasm --dir public/wasm
gh release download wasm-runtime-v1 --pattern valhalla.js  --dir public/wasm

pnpm run build:sdk
```

Then point the app at a dataset and start the dev server:

```bash
cp .env.local.example .env.local
# .env.local
VITE_MANIFEST_URL=https://valhalla-route-id.gislabs.workers.dev/datasets/indonesia-260926-eab7ae90e4197185/manifest.json

pnpm dev        # http://localhost:5173
```

**`VITE_MANIFEST_URL` is required.** Without it the app builds fine but reports a `CONFIG` error
instead of routing. Two rules apply to whatever you point it at:

- the manifest URL's parent directory must equal the manifest's own `release` field, and
- the graph must have been built from the same Valhalla revision as the WASM binary.

The loader checks both and fails with `INCOMPATIBLE_DATASET` rather than routing on a mismatched
graph.

To serve a release from disk instead of over the network — useful when you have the graph locally —
put it under `public/datasets/` and run `pnpm serve:dataset` (port 8788), then use its manifest URL.

### Checks

```bash
pnpm typecheck:all   # root app, core, browser and server packages
pnpm test            # unit tests plus the WASM smoke tests against the local fixture
pnpm test:worker     # the Worker's range handler under the Cloudflare Workers pool
pnpm build           # production bundle
pnpm test:e2e        # Playwright acceptance route; needs a running deployment
```

`pnpm test` routes against the small Liechtenstein fixture in `public/datasets/`, which is built by
`pnpm run data:region` (Docker) and is not committed. `pnpm test:e2e` reads `E2E_BASE_URL`
(default: the live URL) and, on machines where the bundled browser download is unavailable, accepts
`E2E_CHANNEL=chrome` to drive an installed Google Chrome instead.

## The dataset

| | |
| --- | --- |
| Release | `indonesia-260926-eab7ae90e4197185` |
| Source | Geofabrik Indonesia extract, OSM snapshot **2026-09-26** (1,737,376,451 B PBF) |
| Coverage | the Indonesian archipelago — `94.97,-11.01,141.03,6.08` (all of Sumatra, Java, Kalimantan, Sulawesi, Nusa Tenggara, Maluku and Papua) |
| Graph | 5,271 tiles, `graph.tar` 2,041,282,560 B, 10,329,891 nodes, each carrying a timezone |
| Costings | `auto`, `motorcycle`, `motor_scooter`, `truck`, `bicycle`, `pedestrian` |
| Built with | Valhalla `a60c7cbfc83e073f50887cd27e0109d02e6b64e5` (3.8.3) |
| Record | [`docs/datasets/indonesia-260926-eab7ae90e4197185.md`](docs/datasets/indonesia-260926-eab7ae90e4197185.md) |

Only Indonesia is covered. Points outside the release's bounding box have no graph, and the app
reports the engine's error rather than guessing.

### Routing data is verified against the native engine

A 16-request corpus (short urban pairs, long inter-island pairs, ferries, a departure time, all six
costings) was routed twice — once by the pinned native binary inside the exact build image, once
through the WASM runtime in a browser-shaped environment — and the two answers compared as
serialised text, with no key reordering and no number fiddling.

**14 of the 16 requests are byte-identical.** The two exceptions are `bicycle` and `pedestrian`
against the SDK's own 300-second operation deadline: both are *timeouts inside the host*, not engine
disagreements — the WASM engine never produced an answer to compare, and native answered the same
requests instantly. Zero disagreements were classified. Full detail, including the equality rule and
the per-case outcome, is in
[`docs/datasets/indonesia-260926-eab7ae90e4197185-verification.md`](docs/datasets/indonesia-260926-eab7ae90e4197185-verification.md).

## Known limitations

- **Instructions are in English.** The UI is in Bahasa Indonesia, but the shipped WASM binary
  carries only the `en-US` locale, so manoeuvre text ("Turn right onto Jalan …") stays English.
- **`bicycle` and `pedestrian` are slow, and `bicycle` may not finish.** An 11 km bicycle route
  exceeds the SDK's 300-second operation deadline, where the native binary answers instantly; an
  11 km pedestrian route took 56 s against 88 s for a 156 km car route. Both profiles are marked
  🐌 in the UI and are interruptible, but treat bicycle routing from this runtime build as
  unreliable.
- **A 96 MiB tile budget is required.** The browser build asks the SDK for 96 MiB of decoded-tile
  cache; the two largest tiles in this release are 46.2 MiB and 35.7 MiB, so the SDK's 32 MiB
  default cannot even initialise. A device that cannot spare that memory will fail to load.
- **Indonesia only.** Coverage is the release above; there is no global graph.
- **A cold first route is heavy.** It can read a few hundred megabytes of ranges out of the 2 GB
  archive, and has been measured at 79–101 s for the largest (48 MB) tile on a congested link.
  Later routes reuse the in-memory tile cache.

## Attribution

- Routing data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, licensed
  under [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). The graph is derived from the
  Geofabrik Indonesia extract pinned in the dataset record; timezone polygons come from
  timezone-boundary-builder (also ODbL).
- [Valhalla](https://github.com/valhalla/valhalla) 3.8.3 — MIT. The compiled runtime also bundles
  its dependencies (Boost, Protobuf, zlib, RapidJSON, date, unordered_dense, cpp-statsd-client,
  protozero, vtzero, the IANA timezone database, Emscripten/LLVM and musl); their license texts ship
  beside the runtime in `public/wasm/licenses/` and are summarised in [`NOTICE.md`](NOTICE.md).
- [valhalla-wasm](https://github.com/tobilg/valhalla-wasm) — MIT. This project vendors a pinned fork
  of it under `packages/`, with the upstream license kept at
  [`third_party/valhalla-wasm/LICENSE`](third_party/valhalla-wasm/LICENSE).
- Basemap tiles © [CARTO](https://carto.com/attributions), using OpenStreetMap data.
- This repository itself is MIT — see [`LICENSE`](LICENSE).

## Repository layout

```
.github/workflows/ci.yml   verify on every push and PR; deploy + acceptance on main
e2e/                       Playwright acceptance route against a live deployment
src/                       the SPA: map, route panel, status bar, scenario state
packages/valhalla-core/    request validation, costing profiles, tile store and loader
packages/valhalla-browser/ the WASM runtime packaged for the browser
packages/valhalla-server/  the same runtime for Node and Cloudflare Workers
worker/                    the Worker: static assets plus range responses from R2
public/wasm/               runtime artifacts (built, not committed)
public/datasets/           graph releases (built, not committed)
native/                    the pinned native binary used as the verification reference
tools/                     dataset serving, smoke tests, publication and verification scripts
docs/datasets/             the build record and the native-versus-WASM verification report for the
                           published release
```

## Continuous integration

`.github/workflows/ci.yml` runs `verify` on every push and pull request — install, typecheck, unit
and Worker tests, production build — and `deploy` only on `main`, which publishes the Worker with
`cloudflare/wrangler-action` and then runs the Playwright acceptance route against the deployment.
Two runs on the same ref cancel the older one.

CI has no Docker, so the three artifacts that only the pinned Docker build produces arrive as GitHub
release assets instead:

| Release | Assets | Why |
| --- | --- | --- |
| [`wasm-runtime-v1`](https://github.com/dhanyyudi/valhalla-route-id/releases/tag/wasm-runtime-v1) | `valhalla.wasm`, `valhalla.js` | `pnpm run build:wasm` output; `build:sdk` verifies each download against `native/runtime-lock.json` |
| [`ci-fixtures-v1`](https://github.com/dhanyyudi/valhalla-route-id/releases/tag/ci-fixtures-v1) | `runtime-licenses.tar.gz`, `liechtenstein-2015-v1-*.tar.gz` | the dependency license texts `build:sdk` refuses to package without, and the small Liechtenstein graph the smoke tests route against |

The `deploy` job needs three repository settings, which hold no values in this repository:

| Name | Kind | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | secret | token used by `cloudflare/wrangler-action` to publish the Worker |
| `CLOUDFLARE_ACCOUNT_ID` | secret | Cloudflare account that owns the Worker and the R2 bucket |
| `PROD_URL` | variable | origin the acceptance spec routes against, for example `https://valhalla-route-id.<account>.workers.dev` |
