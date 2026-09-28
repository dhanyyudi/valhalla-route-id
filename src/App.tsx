import { useCallback, useEffect, useRef, useState } from 'react';
import { LngLatBounds, type Map as MapLibreMap } from 'maplibre-gl';
import { decodeScenario, encodeScenario } from './core/share-url';
import { MapView } from './map/MapView';
import { corridorBounds, drawGageLayer, setGageVisible } from './map/gage-layer';
import {
  animateRoute, clearLegLabels, clearRoutes, clearWaypoints, drawLegLabels, drawRoute, drawWaypoints,
  routeCoordinates, setRouteStale, setWaypointsBusy, type AnimationFrame,
} from './map/route-layer';
import { useProcessLog } from './state/process-log';
import { MAX_WAYPOINTS, isResultStale, resultMatchesStops, useScenario } from './state/scenario';
import { useView } from './state/view';
import { GageLegend, MapSidebar, ViewControls } from './ui/MapSidebar';
import { ProcessLog } from './ui/ProcessLog';
import { RouteHud } from './ui/RouteHud';
import { RoutePanel } from './ui/RoutePanel';
import { RoutingLoader } from './ui/RoutingLoader';
import { StatusBar } from './ui/StatusBar';
import { Toast, useToast } from './ui/Toast';
import { WasmExplainer } from './ui/WasmExplainer';
import { useTimeline } from './ui/useTimeline';
import './styles.css';

/** Read a shared scenario from the address bar once, before the first render reads the store. */
const shared = typeof location === 'undefined' ? {} : decodeScenario(location.search);
if (Object.keys(shared).length > 0) useScenario.getState().hydrate(shared);
/** Module-level, so StrictMode's second effect pass in development does not queue a second run. */
let sharedRunRequested = false;

/** Whether a media query matches, kept live. */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const list = matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return matches;
}

/**
 * Padding that keeps a fitted route clear of the panel on the left and the sidebar on the right.
 * Measured from the columns actually on screen and capped at 30% of the width each: fixed 400 px
 * sides were wider than a portrait tablet's map, and MapLibre then refused to fit at all.
 */
function fitPadding(map: MapLibreMap) {
  const box = map.getContainer().getBoundingClientRect();
  const cap = (value: number) => Math.max(20, Math.min(value, box.width * 0.3));
  const panel = document.querySelector('[data-testid="route-panel"]')?.getBoundingClientRect();
  const sidebar = document.querySelector('[data-testid="map-sidebar"]')?.getBoundingClientRect();
  const footer = document.querySelector('[data-testid="status-bar"]')?.getBoundingClientRect();
  return {
    top: 60,
    bottom: cap(footer ? box.bottom - footer.top + 20 : 120),
    left: cap(panel && panel.width < box.width * 0.6 ? panel.right - box.left + 20 : 30),
    right: cap(sidebar ? box.right - sidebar.left + 20 : 30),
  };
}

export default function App() {
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const [geometryPoints, setGeometryPoints] = useState<number | null>(null);
  const [frame, setFrame] = useState<AnimationFrame | null>(null);
  const [viewSheet, setViewSheet] = useState(false);
  const waypoints = useScenario(state => state.waypoints);
  const result = useScenario(state => state.result);
  const gage = useScenario(state => state.gage);
  const status = useScenario(state => state.status);
  const legLabels = useView(state => state.legLabels);
  const animate = useView(state => state.animate);
  const replay = useView(state => state.replay);
  const showGage = useView(state => state.showGage);
  const logOpen = useProcessLog(state => state.open);
  const timeline = useTimeline();
  const stale = useScenario(isResultStale);
  const stopsMatch = useScenario(resultMatchesStops);
  const fittedShared = useRef(false);
  // jsdom has no matchMedia; the desktop layout is the one the shell test renders.
  // The two side columns need ~46rem between them; below 1024 px (tablets in portrait) they left a
  // sliver of map, so the sidebar becomes the phone's sheets there too.
  const wide = useMediaQuery('(min-width: 1024px)') || typeof matchMedia !== 'function';

  const addWaypoint = useCallback((point: { lng: number; lat: number }) => {
    if (!useScenario.getState().addWaypoint(point)) {
      useToast.getState().show(`Maksimal ${MAX_WAYPOINTS} titik per rute — hapus satu titik dulu.`, 'error');
    }
  }, []);

  // The address bar always carries the scenario, so a reload or a copied link reopens it.
  useEffect(() => useScenario.subscribe((state, previous) => {
    if (state.waypoints === previous.waypoints && state.profile === previous.profile && state.timeMode === previous.timeMode
      && state.departure === previous.departure && state.plateParity === previous.plateParity && state.options === previous.options) return;
    const options = Object.fromEntries(Object.entries(state.options).filter(([, value]) => typeof value !== 'string')) as Record<string, number | boolean>;
    const query = encodeScenario({ ...state, options });
    history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
  }), []);

  // A shared link with a route in it is calculated straight away; routing does not need the map.
  useEffect(() => {
    if (sharedRunRequested || (shared.waypoints?.length ?? 0) < 2) return;
    sharedRunRequested = true;
    useScenario.getState().requestRun();
  }, []);

  // ...and the map frames its stops as soon as it exists.
  useEffect(() => {
    if (!map || fittedShared.current || !shared.waypoints?.length) return;
    fittedShared.current = true;
    const bounds = new LngLatBounds();
    for (const point of shared.waypoints) bounds.extend([point.lng, point.lat]);
    map.fitBounds(bounds, { padding: fitPadding(map), maxZoom: 14, duration: 0 });
  }, [map]);

  // Waypoint markers track the list; their clocks and colours come from the route on screen, and
  // only while that route still has one leg per gap between the stops being shown.
  useEffect(() => {
    if (!map) return;
    drawWaypoints(map, waypoints, {
      times: stopsMatch ? timeline?.times : undefined,
      colored: stopsMatch,
      // The store re-routes after the move when auto-route is on.
      onMove: (index, point) => useScenario.getState().moveWaypoint(index, point),
      onRemove: index => useScenario.getState().removeWaypoint(index),
    });
    setWaypointsBusy(map, useScenario.getState().status === 'routing');
    // No cleanup here: `drawWaypoints` replaces its own markers, and must be able to leave a marker
    // that is being dragged alone. The markers go with the map.
  }, [map, waypoints, stopsMatch, timeline]);

  useEffect(() => () => { if (map) clearWaypoints(map); }, [map]);

  useEffect(() => {
    if (map) setRouteStale(map, stale);
  }, [map, stale, result]);

  useEffect(() => {
    if (map) setWaypointsBusy(map, status === 'routing');
  }, [map, status]);

  // Corridors are drawn under the route and recoloured by the constraint: terracotta once a route
  // was requested with them excluded, yellow while the constraint is off or simply not in force.
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
    if (map) setGageVisible(map, showGage);
  }, [map, showGage, gage]);

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
    // Bring the route into view only when part of it is off screen, so a drag-and-reroute keeps the
    // camera where the user put it.
    const coordinates = routeCoordinates(result);
    const view = map.getBounds();
    if (coordinates.length > 0 && coordinates.some(point => !view.contains(point))) {
      const bounds = new LngLatBounds();
      for (const point of coordinates) bounds.extend(point);
      map.fitBounds(bounds, { padding: fitPadding(map), maxZoom: 15, duration: 700 });
    }
  }, [map, result]);

  // Trace the new route from the first stop to the last; a replay runs it again.
  useEffect(() => {
    if (!map || !result || !animate) {
      setFrame(null);
      return;
    }
    let last = 0;
    const stop = animateRoute(map, result, next => {
      // The HUD needs ~10 updates a second, not 60; the map itself is redrawn every frame.
      const now = performance.now();
      if (next.done || now - last > 90) {
        last = now;
        setFrame(next);
      }
    });
    return stop;
  }, [map, result, animate, replay]);

  useEffect(() => {
    if (!map) return;
    // Labels describe the legs between the listed stops; once a stop moves they would lie about it.
    if (!result || !timeline || !stopsMatch) {
      clearLegLabels(map);
      return;
    }
    drawLegLabels(map, result, timeline.legs, timeline.times, legLabels);
  }, [map, result, timeline, legLabels, stopsMatch]);

  const zoomToGage = useCallback(() => {
    if (!map) return;
    const [west, south, east, north] = corridorBounds();
    map.fitBounds([[west, south], [east, north]], { padding: fitPadding(map), duration: 800 });
    if (!useView.getState().showGage) useView.getState().setShowGage(true);
  }, [map]);

  return (
    <main className="relative h-full w-full overflow-hidden">
      <MapView onMapClick={addWaypoint} onReady={setMap} />
      <RoutePanel />
      {wide ? (
        <MapSidebar onZoomToGage={zoomToGage} />
      ) : logOpen ? (
        // Phones: no sidebar, so the log and the view controls are sheets behind their own buttons.
        <ProcessLog className="absolute inset-x-2 bottom-16 z-40 h-[42dvh] md:bottom-24" />
      ) : viewSheet ? (
        <div className="absolute inset-x-2 bottom-16 z-40 flex flex-col gap-2 md:bottom-24">
          <ViewControls />
          <GageLegend onZoomToGage={zoomToGage} />
          <button type="button" className="nb-button self-end px-2 py-1 text-xs" onClick={() => setViewSheet(false)}>Tutup</button>
        </div>
      ) : (
        <div className="absolute bottom-16 right-2 z-30 flex gap-2 md:bottom-24 md:right-4">
          <button type="button" data-testid="open-view-mobile" className="nb-button px-2 py-1 text-xs" onClick={() => setViewSheet(true)}>
            Tampilan
          </button>
          <button
            type="button"
            data-testid="open-log-mobile"
            className="nb-button px-2 py-1 text-xs"
            onClick={() => useProcessLog.getState().setOpen(true)}
          >
            Log WASM
          </button>
        </div>
      )}
      <RoutingLoader />
      {status !== 'routing' ? <RouteHud frame={frame} /> : null}
      <WasmExplainer />
      <Toast />
      <StatusBar geometryPoints={geometryPoints} />
    </main>
  );
}
