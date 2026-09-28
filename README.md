# Valhalla Route ID

A public **Valhalla routing inspector for Indonesia** that runs entirely in the browser. Valhalla
3.8.3 is compiled to WebAssembly; the country's road graph lives in Cloudflare R2 and is pulled on
demand as HTTP byte ranges. Place waypoints on the map, pick a vehicle and a departure or arrival
time, and inspect the route the engine actually returned — geometry, distance, duration and
turn-by-turn manoeuvres.

Nothing routes on a server. The app is a static bundle. The only *routing* traffic leaving the
browser is the graph data it reads; the map also fetches its basemap style, vector tiles and glyphs
from CARTO, which is third-party traffic on every page load (see [Attribution](#attribution)).

**Live:** <https://valhalla-route-id.gislabs.workers.dev>

## What it does

- Place two or more waypoints by clicking the map, or by pasting `lat, lon` pairs or a Google Maps
  link into the paste box.
- Route for `auto`, `motorcycle`, `motor_scooter`, `truck`, `bicycle` or `pedestrian`.
- Route now, depart at, or arrive by a time in the dataset's local time, with quick hour presets.
- Tune the costing options that profile exposes — top speed, highways, tolls, ferries, trails, and
  truck dimensions/weight/hazmat.
- Drag a waypoint marker to move it: the route is recalculated as soon as it is dropped (a drag
  during a running route waits for that route rather than cancelling it and its tile cache).
  Right-click a marker to remove it.
- Watch the routing loader step through the WASM runtime, the graph index and the route search,
  with the graph tiles read so far, and cancel a long route. The **process log** beside the map lists
  every phase and tile the worker reports plus the loader, cache and heap counters each route
  returns, and can be copied.
- Read the result on the map: one colour per leg, a start/arrival clock on every waypoint, and an
  optional per-leg label (speed, ETA or both). The route is traced from the first stop to the last,
  timed by native's own maneuver times, with a simulated clock; replay it or turn it off.
- Read the distance, duration, simulated departure/arrival time, dataset release, bytes fetched and
  decoded geometry from the status bar, and a per-leg table (distance, time, mean speed, arrival).
- Share a scenario: the address bar always carries it (`?wp=lat,lng;lat,lng&profile=…&time=…&at=…
  &plate=…&opt=…`), a link with two or more stops routes on open, and the panel copies the link, the
  exact Valhalla request JSON or the route as GeoJSON.
- Apply the Jakarta **ganjil-genap** (odd-even) constraint: pick `Ganjil`, `Genap` or `Nonaktif`, and
  when the rule bites, the request carries `exclude_polygons` so Valhalla routes around the
  restricted corridors — and the panel says afterwards which corridors the route still crosses.
  On the map each corridor is a tinted, hatched buffer with a dashed edge, a glowing centre-line and
  its street name, and a dot at low zoom: red while the last route was asked to avoid it, yellow
  otherwise. Hover a corridor for its rule; the legend beside the map can hide the layer or zoom to it.

## Ganjil-genap constraint

The rule is evaluated from the scenario, never from the wall clock: the simulated departure time (the
arrival time for an `arrive_by` scenario) decides whether the constraint is in force, so a shared
scenario always reproduces the same verdict. There is no fallback to the current time — a `Berangkat`
or `Tiba` box left empty or unreadable makes the panel refuse to evaluate the rule and refuse to
route, and say so, rather than route on an instant the scenario does not name ("Sekarang" is the mode
that means the wall clock, and it is the only one). It follows Pergub DKI 88/2019 as the source
implementation does — Monday to Friday, 06:00–10:00 and 16:00–21:00 WIB, plate parity against the
date's parity, Jakarta/Jabodetabek only, and **motorcycles and motor scooters exempt** (the panel says
so rather than silently ignoring the toggle).

When the verdict is `restricted`, `src/core/gage-request.ts` packs buffered corridor rings into the
request's `exclude_polygons` field and `src/core/gage-crossing.ts` intersects the returned geometry
against the same rings. Two limits shape what that can achieve, and the interface reports both:

- Valhalla accepts a ring as a JSON array of `[longitude, latitude]` pairs — not the comma-separated
  string an earlier spike passed, which the engine silently ignores entirely (see the header of
  `tools/build-gage-polygons.ts` for the source evidence and the probe that confirmed it).
- `service_limits.max_exclude_polygons_length` is 10,000 m and it applies to the **sum** of every
  ring's perimeter in one request. The 25 corridors are ~141 km of buffered ring between them, so a
  request carries about 9.5 km of it: the rings overlapping the route most, with the rest named in
  the crossing report instead of being quietly dropped. Plan for the constraint to bend a route, not
  to make it exempt.

The corridors are data, not code: `data/jakarta-ganjil-genap.geojson` holds 25 named LineStrings each
declaring `bufferMeters: 35` (and 28 toll-access Points this feature does not use), and
`pnpm build:gage` turns them into `src/data/gage-polygons.json` — closed, measured rings plus the
centre-lines the map draws. `pnpm build:gage:check` fails when that artifact is stale; a unit test
asserts the output is byte-identical between runs, that every ring is closed and non-degenerate, and
that each buffered area matches the corridor length it came from.

## How it works

One Cloudflare Worker is the whole backend:

| Piece | Where it lives | Notes |
| --- | --- | --- |
| SPA | Worker static assets (`dist/`) | Vite + React + TypeScript + Tailwind v4 + MapLibre GL |
| Routing engine | `public/wasm/valhalla.wasm` (10,109,445 B) + `valhalla.js` glue | Valhalla 3.8.3 cross-compiled with Emscripten; runs in a Web Worker in the browser |
| Road graph | R2 bucket behind `/datasets/*` | `graph.tar` (2,041,282,560 B) split into 5,271 tiles; the Worker answers `Range` requests so a route downloads only the tiles it touches |
| SDK | `packages/valhalla-*` | A pinned fork of [`tobilg/valhalla-wasm`](https://github.com/tobilg/valhalla-wasm) 0.2.1 with its own request validator and a fetch-backed tile store |

The browser asks for the release manifest, learns every tile's offset, length and ETag, then reads
the byte ranges it needs straight out of the archive. Those responses are immutable for a year, so
the browser's HTTP cache can replay them — but that is not what makes a route cheap. The decoded-tile
cache is: Valhalla keeps tiles in a budgeted LRU and re-reads whatever it evicted, so the budget has
to cover a route's whole working set, not merely its largest tile.

Measured against the deployed Worker with `e2e/cache-budget.spec.ts` — one 24.5 km Jakarta route,
`auto`, `-6.18330, 106.78038` → `-6.19860, 106.87630`, cold browser cache, `router.diagnostics()`
read after the result:

| Build | Wall time | Graph bytes | Tile reads | Distinct tiles | WASM heap high-water |
| --- | --- | --- | --- | --- | --- |
| 96 MiB budget, 512 MiB heap (previous deployment) | 503.7 s (second run of the same build: 309.1 s) | 3,459,976,392 B | **146** | 4 | 184.4 MiB |
| 384 MiB budget, 1024 MiB heap (current) | 16.2 s (re-run: 14.7 s) | 101,346,424 B | **4** | 4 | 153.6 MiB |

The same four tiles cost 101,346,424 B when each is read once. That working set is 683,128 B larger
than the 96 MiB the app used to request, so the cache could never hold it: every tile Valhalla
evicted was one the next expansion asked for again — 146 downloads for four tiles, and the search
did the same work either way (153,108 native cache hits before, 153,250 after). At 384 MiB the route
reads each tile exactly once, ends the route with all 101,346,424 B still decoded, and peaks at
153.6 MiB of heap instead of 184.4 MiB, because it no longer decodes four tiles 146 times. The
wall-time spread between two runs of the *same* build on this link is itself minutes, so the byte
and tile-read counts are the stable measurement, not the seconds.

The heap ceiling is 1024 MiB rather than the SDK's browser default of 512 MiB, because a 384 MiB
cache plus a long search's own labels can exceed 512 MiB: a Jakarta → Bandung `bicycle` route
(~165 km, 48 tiles, 413,159,328 B) failed after 44.9 s with
`RESOURCE_LIMIT: Native routing exhausted its WASM memory budget.` at the 512 MiB default and
completes in 65.5 s with a 683 MiB heap high-water once the ceiling is raised. The short routes
above never approach it, and linear memory only grows on demand.

The tile cache is explicitly budgeted: the app requests **384 MiB** (`memoryBudgetBytes` 402653184),
overridable at build time with `VITE_MEMORY_BUDGET_MIB` (the vendored engine's ceiling is 512 MiB).
The largest tile in this release is 48,442,160 B, so the SDK's 32 MiB default refuses to initialise
against this dataset at all. See divergence 11 in [`UPSTREAM.md`](UPSTREAM.md) for why the ceiling
had to move.

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
Both that server and the deployed Worker answer `/datasets/*` with `Access-Control-Allow-Origin: *`,
so either manifest URL can be read from the `http://localhost:5173` dev server.

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

`e2e/cache-budget.spec.ts` is the cache measurement behind the table above: it routes one pair,
records the wall time, the reported graph bytes, `router.diagnostics()` and the tile ids the
progress line shows, and writes its evidence to `.superpowers/measurements/<label>.json`.
`E2E_PROFILE`, `E2E_START`, `E2E_END` and `E2E_LABEL` select the case, for example:

```bash
E2E_CHANNEL=chrome E2E_LABEL=after-auto npx playwright test e2e/cache-budget.spec.ts
```

`VITE_MEMORY_BUDGET_MIB` rebuilds the app with a different decoded-tile cache budget so two budgets
can be compared without editing code (`VITE_MEMORY_BUDGET_MIB=96 pnpm build`).

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
through the same WASM runtime, SDK loader and tile store in Node (`valhalla-server/node`, WASM
memory 256/512 MiB rather than the browser adapter's 128/512) — and the two answers compared as
serialised text, with no key reordering and no number fiddling.

**14 of the 16 requests are byte-identical.** The two exceptions are `bicycle` and `pedestrian`
against the SDK's own 300-second operation deadline: both are *timeouts inside the host*, not engine
disagreements — the WASM engine never produced an answer to compare, and native answered the same
requests instantly. Zero disagreements were classified. Those two timeouts were measured against the
96 MiB cache budget this repository shipped at the time and are the reason the budget moved: with
384 MiB of cache and a 1024 MiB heap the same `jakarta-bandung-bicycle` request, driven through the
SDK's own Node worker at the corpus's settings, completes in 2.5 s (413,159,328 B read, 683 MiB heap
high-water) instead of exhausting either the cache or the deadline. Full detail, including the
equality rule and the per-case outcome, is in
[`docs/datasets/indonesia-260926-eab7ae90e4197185-verification.md`](docs/datasets/indonesia-260926-eab7ae90e4197185-verification.md).

## Known limitations

- **Instructions are in English.** The UI is in Bahasa Indonesia, but the shipped WASM binary
  carries only the `en-US` locale, so manoeuvre text ("Turn right onto Jalan …") stays English.
- **`pedestrian` is still unmeasured; `bicycle` no longer times out.** The corpus timeout recorded
  for an 11 km bicycle route was taken with a 96 MiB cache. Re-measured on the deployed build, a
  24.5 km bicycle route takes 16.2 s and the 165 km `jakarta-bandung-bicycle` case 65.5 s — both
  inside the 300 s deadline. The UI still marks `bicycle` and `pedestrian` 🐌; that marker now
  overstates `bicycle`'s cost, and `pedestrian` has not been re-measured since the budget changed.
- **A 384 MiB tile budget and a 1024 MiB heap ceiling are required.** The browser build asks the SDK
  for 384 MiB of decoded-tile cache inside a WASM heap whose maximum is 1024 MiB rather than the
  adapter's 512 MiB default. The four tiles of a single 24.5 km Jakarta route already total
  101,346,424 B, so a smaller budget does not fail — it thrashes, re-reading what it evicted (96 MiB
  measured 146 reads for those same four tiles), and a 512 MiB heap fails outright on the long
  bicycle route (`RESOURCE_LIMIT`, measured at 44.9 s). A device that cannot spare the memory will
  be slow or fail on the longest routes rather than quietly wrong.
- **Indonesia only.** Coverage is the release above; there is no global graph.
- **A cold first route is heavy, and now bounded by the working set.** The measured 24.5 km Jakarta
  route reads 101,346,424 B out of the 2 GB archive in 16.2 s on a cold browser cache, and the
  Jakarta → Bandung acceptance route (`motorcycle`, 07:00) 207,897,560 B in 36.1 s — against
  369,466,864 B in 46.1 s for the same acceptance route before the change. Before the cache budget
  was raised, the short route reported 3,459,976,392 B and took 309–504 s. A later route is cheaper
  only in that the browser's HTTP cache can replay immutable responses; the decoded-tile cache is
  what prevents the re-reads.

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
- Ganjil-genap corridor geometry: `data/jakarta-ganjil-genap.geojson`, version 2.0.0 (built
  2026-05-09), converted from the public community Google My Maps
  ["Ganjil Genap (GaGe) Jakarta 2026"](https://www.google.com/maps/d/kml?mid=1MJ723E9f9hrwzbuWcK1mVDzlRVw4uyTz&forcekml=1)
  — 25 road corridors plus 28 toll-access points. Bundled with its `_meta` block intact; the
  redistribution is by permission of nothing but the source's own public sharing, so if that is
  unwanted the file can move to R2 and be fetched at runtime without a code change beyond the data
  URL.
- This repository itself is MIT — see [`LICENSE`](LICENSE).

## Repository layout

```
.github/workflows/ci.yml   verify on every push and PR; deploy + acceptance on main
e2e/                       Playwright acceptance route and the decoded-tile cache measurement,
                           both against a live deployment
src/                       the SPA: map, route panel, status bar, scenario state, ganjil-genap rules
src/core/leg-timeline.ts   per-leg figures and per-waypoint clock times
src/core/share-url.ts      the scenario as query parameters, both ways
src/state/process-log.ts   the process log and the loader's per-run counters
src/state/view.ts          display-only preferences (leg labels, animation, auto-route, corridors)
src/data/gage-polygons.json  generated corridor rings (pnpm build:gage), committed
data/                      ganjil-genap corridor source data, committed with its _meta provenance
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
