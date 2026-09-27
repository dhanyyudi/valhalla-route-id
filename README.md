# Valhalla Route ID

A public, backend-free **Valhalla routing inspector for Indonesia**. Valhalla 3.8.3 runs entirely in the browser through WebAssembly; graph tiles for the whole country are fetched on demand over HTTP byte ranges. Pick waypoints on the map, choose a vehicle and a departure/arrival time, tune costing options, and inspect the real native request and response — plus alternates, isochrones, optimized visit order, and distance/time matrices.

Nothing routes on a server. The SPA is static; only the graph data and tile requests leave the browser.

- **Design spec:** [`docs/superpowers/specs/2026-09-27-valhalla-route-id-inspector-design.md`](docs/superpowers/specs/2026-09-27-valhalla-route-id-inspector-design.md)
- **Engine:** [Valhalla](https://github.com/valhalla/valhalla) 3.8.3 via a fork of [`tobilg/valhalla-wasm`](https://github.com/tobilg/valhalla-wasm) (MIT)
- **Stack:** Vite · React · TypeScript · Tailwind v4 · NeoBrutalism · MapLibre GL
- **Deploy:** a single Cloudflare Worker on its default `*.workers.dev` URL — static assets for the SPA, an R2 binding streaming byte ranges for graph data

Routing data © OpenStreetMap contributors, [ODbL 1.0](https://www.openstreetmap.org/copyright). Timezone polygons from timezone-boundary-builder.
