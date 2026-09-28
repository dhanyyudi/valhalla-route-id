import { useEffect, useRef } from 'react';
import { Map as MapLibreMap, setWorkerUrl, type LngLatLike } from 'maplibre-gl';
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

  useEffect(() => {
    if (!container.current || map.current) return;
    const instance = new MapLibreMap({
      container: container.current,
      style: DARK_STYLE,
      center: initialCamera.current.center,
      zoom: initialCamera.current.zoom,
      attributionControl: { compact: true },
    });
    instance.on('click', event => clickHandler.current?.({ lng: event.lngLat.lng, lat: event.lngLat.lat }));
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
  return <div ref={container} data-testid="map" className="h-full w-full" />;
}
