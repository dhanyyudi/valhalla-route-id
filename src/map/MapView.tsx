import { useEffect, useRef, useState } from 'react';
import { Map as MapLibreMap, NavigationControl, ScaleControl, setWorkerUrl, type LngLatLike } from 'maplibre-gl';
// MapLibre builds its parser worker URL itself, from a *computed* file name
// (`./maplibre-gl-worker.mjs` next to `import.meta.url`), which no bundler can rewrite. In this
// build that resolved to /assets/maplibre-gl-worker.mjs, the Worker's SPA fallback answered it
// with index.html, and the map never fired `load` at all. Asking Vite to bundle the worker's own
// module graph and hand back its URL is the supported fix.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';

const DARK_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
/**
 * Camera defaults are module constants, not prop defaults. An array literal in the parameter list
 * is a new value on every render, so a `[center, zoom]` dependency recreated the whole map each
 * time the parent rendered; the camera is now read once, when the map is created.
 */
const DEFAULT_CENTER: LngLatLike = [118.0, -2.5];
const DEFAULT_ZOOM = 4.2;

setWorkerUrl(maplibreWorkerUrl);

export interface MapViewProps {
  /** Initial camera centre; later changes are ignored so the map is never rebuilt mid-session. */
  center?: LngLatLike;
  /** Initial zoom; later changes are ignored, as with `center`. */
  zoom?: number;
  onMapClick?: (lngLat: { lng: number; lat: number }) => void;
  /**
   * Called once with the map, after the basemap style has loaded.
   *
   * A layer can only be added to a loaded style, so this — not "the map exists" — is the signal for
   * every overlay the app draws, including the ganjil-genap corridors.
   */
  onReady?: (map: MapLibreMap) => void;
}

export function MapView({ center = DEFAULT_CENTER, zoom = DEFAULT_ZOOM, onMapClick, onReady }: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const clickHandler = useRef(onMapClick);
  const readyHandler = useRef(onReady);
  clickHandler.current = onMapClick;
  readyHandler.current = onReady;
  const initialCamera = useRef({ center, zoom });
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!container.current || map.current) return;
    let instance: MapLibreMap;
    try {
      instance = new MapLibreMap({
        container: container.current,
        style: DARK_STYLE,
        center: initialCamera.current.center,
        zoom: initialCamera.current.zoom,
        attributionControl: { compact: true },
      });
    } catch (error) {
      // Without WebGL2 MapLibre throws from its constructor; left uncaught, that unmounted the whole
      // app and left a blank page. The panel, the log and routing itself do not need the map.
      setFailure(error instanceof Error ? error.message : String(error));
      return;
    }
    instance.addControl(new NavigationControl({ visualizePitch: false }), 'top-right');
    instance.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-right');
    instance.on('click', event => {
      // A click on a waypoint marker, a leg label or a popup belongs to that element; without this
      // guard, releasing a dragged marker also dropped a new waypoint underneath it.
      const target = event.originalEvent.target as HTMLElement | null;
      if (target?.closest?.('.maplibregl-marker, .maplibregl-popup')) return;
      clickHandler.current?.({ lng: event.lngLat.lng, lat: event.lngLat.lat });
    });
    // Right-click is "remove this waypoint" on a marker; the browser menu would cover it.
    instance.getCanvasContainer().addEventListener('contextmenu', event => event.preventDefault());
    instance.on('load', () => {
      // The acceptance test waits for this instead of guessing how long a basemap takes.
      instance.getContainer().dataset.mapReady = 'true';
      readyHandler.current?.(instance);
    });
    map.current = instance;
    return () => { instance.remove(); map.current = null; };
  }, []);

  // Sized with width/height rather than `absolute inset-0`: MapLibre's own stylesheet sets
  // `position: relative` on `.maplibregl-map`, and because it is unlayered CSS it beats Tailwind's
  // layered `absolute` utility. With `inset-0` and no height the container stayed 0 px tall, the
  // canvas never got a size, and the map never fired `load`.
  return (
    <div ref={container} data-testid="map" className="h-full w-full">
      {failure ? (
        <p data-testid="map-error" role="alert" className="nb-panel absolute left-1/2 top-1/2 z-10 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 p-3 text-sm font-bold">
          Peta tidak dapat ditampilkan: {failure}
        </p>
      ) : null}
    </div>
  );
}
