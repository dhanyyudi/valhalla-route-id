import { useCallback, useEffect, useState } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { MapView } from './map/MapView';
import { drawGageLayer } from './map/gage-layer';
import { clearRoutes, clearWaypoints, drawRoute, drawWaypoints } from './map/route-layer';
import { useScenario } from './state/scenario';
import { RoutePanel } from './ui/RoutePanel';
import { StatusBar } from './ui/StatusBar';
import './styles.css';

export default function App() {
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const [geometryPoints, setGeometryPoints] = useState<number | null>(null);
  const waypoints = useScenario(state => state.waypoints);
  const result = useScenario(state => state.result);
  const gage = useScenario(state => state.gage);

  const addWaypoint = useCallback((point: { lng: number; lat: number }) => {
    useScenario.getState().addWaypoint(point);
  }, []);

  // Waypoint markers track the list, route geometry tracks the last result.
  useEffect(() => {
    if (!map) return;
    drawWaypoints(map, waypoints);
    return () => clearWaypoints(map);
  }, [map, waypoints]);

  // Corridors are drawn under the route and recoloured by the constraint: terracotta once a route
  // was requested with them excluded, grey while the constraint is off or simply not in force.
  useEffect(() => {
    if (!map) return;
    const container = map.getContainer();
    const rings = drawGageLayer(map, Boolean(gage && gage.excludePolygons.length > 0));
    // How many corridor rings the layer holds: the browser acceptance test cannot read a canvas, and
    // a zero here after `map-ready` is the signal that the style was not loaded when this ran.
    container.dataset.gageRings = String(rings);
    container.dataset.gageActive = String(Boolean(gage && gage.excludePolygons.length > 0));
  }, [map, gage]);

  useEffect(() => {
    if (!map) return;
    const container = map.getContainer();
    if (!result) {
      clearRoutes(map);
      setGeometryPoints(null);
      container.dataset.routeCoordinates = '';
      return;
    }
    const drawn = drawRoute(map, result);
    setGeometryPoints(drawn);
    // How many coordinates the route layer actually holds: read by the browser acceptance test,
    // which otherwise has no way to see inside a WebGL canvas.
    container.dataset.routeCoordinates = String(drawn);
  }, [map, result]);

  return (
    <main className="relative h-full w-full">
      <MapView onMapClick={addWaypoint} onReady={setMap} />
      <RoutePanel />
      <StatusBar geometryPoints={geometryPoints} />
    </main>
  );
}
