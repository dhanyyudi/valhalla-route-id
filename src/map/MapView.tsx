import { useEffect, useRef } from 'react';
import { Map as MapLibreMap, type LngLatLike } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

const DARK_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

export interface MapViewProps {
  center?: LngLatLike;
  zoom?: number;
  onMapClick?: (lngLat: { lng: number; lat: number }) => void;
  onReady?: (map: MapLibreMap) => void;
}

export function MapView({ center = [118.0, -2.5], zoom = 4.2, onMapClick, onReady }: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const clickHandler = useRef(onMapClick);
  const readyHandler = useRef(onReady);
  clickHandler.current = onMapClick;
  readyHandler.current = onReady;

  useEffect(() => {
    if (!container.current || map.current) return;
    const instance = new MapLibreMap({
      container: container.current,
      style: DARK_STYLE,
      center,
      zoom,
      attributionControl: { compact: true },
    });
    instance.on('click', event => clickHandler.current?.({ lng: event.lngLat.lng, lat: event.lngLat.lat }));
    instance.on('load', () => readyHandler.current?.(instance));
    map.current = instance;
    return () => { instance.remove(); map.current = null; };
  }, [center, zoom]);

  return <div ref={container} data-testid="map" className="absolute inset-0" />;
}
