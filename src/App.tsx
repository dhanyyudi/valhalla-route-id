import { useCallback, useEffect, useState } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { MapView } from './map/MapView';
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

  const addWaypoint = useCallback((point: { lng: number; lat: number }) => {
    useScenario.getState().addWaypoint(point);
  }, []);

  // Waypoint markers track the list, route geometry tracks the last result.
  useEffect(() => {
    if (!map) return;
    drawWaypoints(map, waypoints);
    return () => clearWaypoints(map);
  }, [map, waypoints]);

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
