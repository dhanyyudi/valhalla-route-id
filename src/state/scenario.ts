import { create } from 'zustand';
import type { ProgressEvent as SdkProgress, RouteResult } from 'valhalla-browser';
import { buildRouteRequest, type Profile, type TimeMode, type Waypoint } from '../core/request-builder';
import { planGageRequest, type GagePlan } from '../core/gage-request';
import { findCorridorCrossings, type CrossingReport } from '../core/gage-crossing';
import { type LngLat } from '../core/gage-geometry';
import { type PlateParity } from '../core/ganjil-genap';
import { BUFFER_METERS, CORRIDORS } from '../core/gage-corridors';
import type { RunClock } from '../core/leg-timeline';
import type { SharedScenario } from '../core/share-url';
import { routeCoordinates } from '../map/route-layer';
import { createRouteClient, installLastRequestHook, type RouteClient } from '../router/client';
import { formatBytes, formatDuration, formatKilometers } from '../ui/format';
import { useProcessLog } from './process-log';

export type OptionValue = number | boolean | string;

/** One control in the deliberately small costing-option surface. */
export interface OptionControl {
  key: string;
  label: string;
  kind: 'preference' | 'number' | 'boolean';
  /** Unit shown next to a number input. */
  unit?: string;
  /** Native default, shown as the placeholder so an empty field means "let Valhalla decide". */
  placeholder?: string;
}

const TOP_SPEED: OptionControl = { key: 'top_speed', label: 'Kecepatan maksimum', kind: 'number', unit: 'km/jam', placeholder: 'bawaan' };
const USE_HIGHWAYS: OptionControl = { key: 'use_highways', label: 'Jalan bebas hambatan', kind: 'preference' };
const USE_TOLLS: OptionControl = { key: 'use_tolls', label: 'Jalan tol', kind: 'preference' };
const USE_FERRY: OptionControl = { key: 'use_ferry', label: 'Kapal feri', kind: 'preference' };
const USE_TRAILS: OptionControl = { key: 'use_trails', label: 'Jalur off-road', kind: 'preference' };
const HAZMAT: OptionControl = { key: 'hazmat', label: 'Muatan B3 (hazmat)', kind: 'boolean' };

/**
 * The options each profile accepts.
 *
 * This mirrors the SDK validator's allow-list (`COSTING_OPTIONS` plus `BASE_COSTING_OPTIONS`): a
 * key outside it is rejected with `INVALID_REQUEST: Unsupported option`, so the panel must never
 * show a control the active profile cannot send. `top_speed` is absent for bicycle and pedestrian,
 * and `use_highways`/`use_tolls` are absent for motor_scooter, bicycle and pedestrian.
 */
export const PROFILE_OPTIONS: Record<Profile, OptionControl[]> = {
  auto: [TOP_SPEED, USE_HIGHWAYS, USE_TOLLS, USE_FERRY],
  motorcycle: [TOP_SPEED, USE_HIGHWAYS, USE_TOLLS, USE_FERRY, USE_TRAILS],
  motor_scooter: [TOP_SPEED, USE_FERRY],
  truck: [
    TOP_SPEED, USE_HIGHWAYS, USE_TOLLS, USE_FERRY,
    { key: 'height', label: 'Tinggi', kind: 'number', unit: 'm', placeholder: 'bawaan' },
    { key: 'width', label: 'Lebar', kind: 'number', unit: 'm', placeholder: 'bawaan' },
    { key: 'length', label: 'Panjang', kind: 'number', unit: 'm', placeholder: 'bawaan' },
    { key: 'weight', label: 'Berat', kind: 'number', unit: 'ton', placeholder: 'bawaan' },
    { key: 'axle_load', label: 'Beban gandar', kind: 'number', unit: 'ton', placeholder: 'bawaan' },
    HAZMAT,
  ],
  bicycle: [USE_FERRY],
  pedestrian: [USE_FERRY],
};

/** Profiles this runtime cannot finish a routine 11 km route for inside a sane budget. */
export const SLOW_PROFILES: readonly Profile[] = ['bicycle', 'pedestrian'];

export const PROFILE_LABELS: Record<Profile, string> = {
  auto: 'Mobil',
  motorcycle: 'Motor',
  motor_scooter: 'Skuter',
  truck: 'Truk',
  bicycle: 'Sepeda',
  pedestrian: 'Jalan kaki',
};

/** An SDK or validation failure, kept verbatim so native codes stay meaningful. */
export interface RouteFailure {
  code: string;
  message: string;
  nativeCode?: number;
  retryable?: boolean;
}

export type RouteStatus = 'idle' | 'routing' | 'done' | 'error' | 'cancelled';

export interface ScenarioState {
  waypoints: Waypoint[];
  profile: Profile;
  timeMode: TimeMode;
  departure: string;
  options: Record<string, OptionValue>;
  /** Declared plate parity for the ganjil-genap rule; `off` means the constraint is not applied. */
  plateParity: PlateParity;
  result: RouteResult | null;
  status: RouteStatus;
  error: RouteFailure | null;
  progress: SdkProgress | null;
  /** The constraint plan the last `run()` sent, so the panel reports what was actually requested. */
  gage: GagePlan | null;
  /** Corridors the returned route still runs through; null before the first route. */
  crossings: CrossingReport | null;
  /** The time control as it was when `result` was requested, so waypoint clocks match the route. */
  resultClock: RunClock | null;
  /** A run asked for while another was in progress; it starts as soon as that one settles. */
  rerunQueued: boolean;
  addWaypoint(point: Waypoint): void;
  /** Move one stop, e.g. after its marker was dragged. */
  moveWaypoint(index: number, point: Waypoint): void;
  removeWaypoint(index: number): void;
  reverseWaypoints(): void;
  clearWaypoints(): void;
  setProfile(profile: Profile): void;
  setTime(timeMode: TimeMode, departure?: string): void;
  setOption(key: string, value: OptionValue | undefined): void;
  setPlateParity(plateParity: PlateParity): void;
  /** Re-derive the constraint plan from the current state, for the panel's live status line. */
  gagePlan(): GagePlan;
  /** Seed the scenario from a shared link; fields the link did not carry keep their defaults. */
  hydrate(shared: Partial<SharedScenario>): void;
  run(): Promise<void>;
  /**
   * Run now, or once the route in progress settles.
   * @remarks Used by the auto-route on drag: cancelling a running route terminates the worker and
   *   drops its tile cache, so a drag during a cold route waits for it instead of throwing it away.
   */
  requestRun(): void;
  cancel(): void;
}

const MAX_WAYPOINTS = 25;

/** `datetime-local` value for the next whole hour, in the browser's own timezone. */
export function defaultDeparture(now: Date = new Date()): string {
  const next = new Date(now.getTime());
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}T${pad(next.getHours())}:${pad(next.getMinutes())}`;
}

/** Date part of a `datetime-local` value, so a preset keeps the day the user is looking at. */
export function withPresetHour(departure: string, hour: number): string {
  const day = /^\d{4}-\d{2}-\d{2}/.exec(departure)?.[0] ?? defaultDeparture().slice(0, 10);
  return `${day}T${String(hour).padStart(2, '0')}:00`;
}

/** Turn any thrown value into the verbatim failure the status bar shows. */
export function toRouteFailure(error: unknown): RouteFailure {
  const candidate = error as { code?: unknown; message?: unknown; nativeCode?: unknown; retryable?: unknown } | null;
  const code = typeof candidate?.code === 'string' ? candidate.code : 'RUNTIME';
  const message = typeof candidate?.message === 'string' && candidate.message ? candidate.message : String(error);
  return {
    code,
    message,
    ...(typeof candidate?.nativeCode === 'number' ? { nativeCode: candidate.nativeCode } : {}),
    ...(typeof candidate?.retryable === 'boolean' ? { retryable: candidate.retryable } : {}),
  };
}

/** The geometry the constraint is judged against: the last route if there is one, else the stops. */
export function geometryForGage(state: Pick<ScenarioState, 'result' | 'waypoints'>): LngLat[] {
  if (state.result) return routeCoordinates(state.result);
  return state.waypoints.map(point => [point.lng, point.lat] as LngLat);
}

/**
 * Plan the ganjil-genap constraint for a scenario, without routing anything.
 *
 * @param state - The fields the plan depends on.
 * @returns The verdict, the rings the request would carry and what the budget left out.
 * @remarks Pure and cheap (bounding-box tests over 30 rings), so the panel can call it on every
 *   render and a scenario's status line never lags behind its controls. The wall clock passed here
 *   is read only for a `now` scenario: a `depart`/`arrive` value that does not parse returns a
 *   refusal plan rather than a verdict at the host's current time.
 */
export function gagePlanFrom(state: Pick<ScenarioState, 'plateParity' | 'profile' | 'timeMode' | 'departure' | 'result' | 'waypoints'>): GagePlan {
  return planGageRequest({
    plateParity: state.plateParity,
    profile: state.profile,
    timeMode: state.timeMode,
    departure: state.departure,
    geometry: geometryForGage(state),
    corridors: CORRIDORS,
    bufferMeters: BUFFER_METERS,
    now: new Date(),
  });
}

/** The most recent request `run()` handed to the SDK, exposed read-only for the acceptance test. */
let lastRequest: unknown;
installLastRequestHook(() => lastRequest);

const MANIFEST_URL: string | undefined = import.meta.env.VITE_MANIFEST_URL;

let client: RouteClient | undefined;
/** Whether the session's startup measurements were logged already; they are read once. */
let startupLogged = false;

/**
 * The application's single SDK session, created on first use.
 * @returns The client, or undefined when the build has no `VITE_MANIFEST_URL`.
 */
function routeClient(): RouteClient | undefined {
  if (!MANIFEST_URL) return undefined;
  if (!client) useProcessLog.getState().push('info', 'Membuat sesi Valhalla: Web Worker + modul WASM (sekali per sesi).');
  return (client ??= createRouteClient(MANIFEST_URL, {
    onProgress: event => {
      useScenario.setState({ progress: event });
      useProcessLog.getState().progress(event);
    },
  }));
}

const log = (...args: Parameters<ReturnType<typeof useProcessLog.getState>['push']>) => useProcessLog.getState().push(...args);

export const useScenario = create<ScenarioState>((set, get) => ({
  waypoints: [],
  profile: 'auto',
  timeMode: 'now',
  departure: defaultDeparture(),
  options: {},
  plateParity: 'off',
  result: null,
  status: 'idle',
  error: null,
  progress: null,
  gage: null,
  crossings: null,
  resultClock: null,
  rerunQueued: false,

  addWaypoint(point) {
    const { waypoints } = get();
    if (waypoints.length >= MAX_WAYPOINTS) return;
    set({ waypoints: [...waypoints, point] });
  },
  moveWaypoint(index, point) {
    const { waypoints } = get();
    if (index < 0 || index >= waypoints.length) return;
    set({ waypoints: waypoints.map((existing, position) => (position === index ? { ...existing, lng: point.lng, lat: point.lat } : existing)) });
  },
  removeWaypoint(index) {
    set({ waypoints: get().waypoints.filter((_, position) => position !== index) });
  },
  reverseWaypoints() {
    set({ waypoints: [...get().waypoints].reverse() });
  },
  clearWaypoints() {
    set({ waypoints: [] });
  },
  setProfile(profile) {
    // Options are per-profile: keep the ones the new profile accepts and drop the rest, so the
    // request can never carry a key the SDK validator rejects.
    const allowed = new Set(PROFILE_OPTIONS[profile].map(control => control.key));
    const options = Object.fromEntries(Object.entries(get().options).filter(([key]) => allowed.has(key)));
    set({ profile, options });
  },
  setTime(timeMode, departure) {
    set(departure === undefined ? { timeMode } : { timeMode, departure });
  },
  setOption(key, value) {
    const options = { ...get().options };
    if (value === undefined) delete options[key];
    else options[key] = value;
    set({ options });
  },
  setPlateParity(plateParity) {
    set({ plateParity });
  },
  gagePlan() {
    return gagePlanFrom(get());
  },
  hydrate(shared) {
    const next: Partial<ScenarioState> = {};
    if (shared.waypoints) next.waypoints = shared.waypoints.slice(0, MAX_WAYPOINTS);
    if (shared.timeMode) next.timeMode = shared.timeMode;
    if (shared.departure) next.departure = shared.departure;
    if (shared.plateParity) next.plateParity = shared.plateParity;
    set(next);
    // Through `setProfile`, so options the profile does not accept are dropped exactly as a click would.
    if (shared.options) set({ options: { ...shared.options } });
    if (shared.profile) get().setProfile(shared.profile);
    else get().setProfile(get().profile);
  },
  requestRun() {
    if (get().waypoints.length < 2) return;
    if (get().status === 'routing') {
      if (!get().rerunQueued) log('info', 'Titik berubah saat rute berjalan: rute dihitung ulang begitu yang ini selesai.');
      set({ rerunQueued: true });
      return;
    }
    void get().run();
  },
  async run() {
    const { waypoints, profile, timeMode, departure, options } = get();
    if (waypoints.length < 2) {
      set({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'Tambahkan minimal dua titik sebelum menghitung rute.' } });
      return;
    }
    const active = routeClient();
    if (!active) {
      set({ status: 'error', error: { code: 'CONFIG', message: 'VITE_MANIFEST_URL belum diatur pada build ini, jadi mesin rute tidak dapat dimuat.' } });
      return;
    }
    // The constraint is planned from the scenario, not from the wall clock, and its rings go into
    // the request only for a `restricted` verdict — every other status leaves `exclude_polygons`
    // off the request entirely, so an existing scenario routes exactly as it did before this layer.
    const gage = gagePlanFrom(get());
    // A departure/arrival box that names no readable time refuses the run instead of being routed at
    // an instant the user never asked for (M-6): the panel's verdict and this refusal come from the
    // same plan, so the two cannot disagree about why nothing was sent.
    if (!gage.evaluation) {
      set({ status: 'error', error: { code: 'INVALID_REQUEST', message: gage.refusal ?? 'Waktu tidak terbaca.' } });
      return;
    }
    const clock: RunClock = { timeMode, departure, startedAt: new Date() };
    set({ status: 'routing', error: null, progress: null, gage, rerunQueued: false });
    const request = buildRouteRequest({
      waypoints, profile, timeMode, departure, options,
      ...(gage.excludePolygons.length > 0 ? { excludePolygons: gage.excludePolygons } : {}),
    });
    lastRequest = request;
    const processLog = useProcessLog.getState();
    processLog.beginRun();
    log('info', [
      `Permintaan rute: ${waypoints.length} titik · costing ${profile}`,
      timeMode === 'now' ? 'tanpa date_time (sekarang)' : `date_time ${timeMode === 'depart' ? 'depart_at' : 'arrive_by'} ${departure}`,
      Object.keys(options).length > 0 ? `opsi ${Object.entries(options).map(([key, value]) => `${key}=${String(value)}`).join(', ')}` : 'opsi bawaan',
      gage.excludePolygons.length > 0 ? `exclude_polygons ${gage.excludePolygons.length} ring` : 'tanpa exclude_polygons',
    ].join(' · '));
    try {
      const result = await active.route(request);
      const crossings = findCorridorCrossings(routeCoordinates(result), CORRIDORS);
      const { summary } = result.native.trip;
      const { loader, native } = result.diagnostics;
      log('ok', `Rute selesai: ${formatKilometers(summary.length)} · ${formatDuration(summary.time)} · ${result.native.trip.legs.length} leg · native ${Math.round(result.diagnostics.routeMs).toLocaleString('id-ID')} ms (host ${Math.round(result.diagnostics.hostRouteMs).toLocaleString('id-ID')} ms)`);
      log('info', `Loader: ${loader.tileDownloads} tile diunduh · ${loader.requests} fetch · ${formatBytes(loader.bytes)} · tunggu ${Math.round(loader.sequentialWaitMs).toLocaleString('id-ID')} ms · dedup ${loader.deduplicated} · retry ${loader.retries}`);
      log('info', `Cache tile ter-decode: ${result.diagnostics.decodedCacheHits} hit · ${formatBytes(native.decodedCacheBytes)} tertahan · heap WASM puncak ${formatBytes(native.wasmHeapCapacityHighWaterBytes)}`);
      if (crossings.count > 0) log('warn', `Ganjil-genap: geometri masih melintasi ${crossings.count} koridor: ${crossings.corridors.map(corridor => corridor.name).join(', ')}.`);
      set({ result, status: 'done', error: null, progress: null, crossings, resultClock: clock });
      if (!startupLogged) {
        startupLogged = true;
        const startup = await active.startup();
        if (startup) {
          log('info', `Startup sesi: modul WASM ${Math.round(startup.moduleStartupMs).toLocaleString('id-ID')} ms · graf ${Math.round(startup.graphStartupMs).toLocaleString('id-ID')} ms · worker siap ${Math.round(startup.workerReadyMs).toLocaleString('id-ID')} ms · rilis ${startup.release}`);
        }
      }
    } catch (error) {
      const failure = toRouteFailure(error);
      const cancelled = failure.code === 'CANCELLED';
      log(cancelled ? 'warn' : 'error', `${failure.code}${failure.nativeCode === undefined ? '' : ` (native ${failure.nativeCode})`}: ${failure.message}`);
      set({ status: cancelled ? 'cancelled' : 'error', error: failure, progress: null, crossings: null });
    } finally {
      processLog.endRun();
    }
    if (get().rerunQueued && get().status !== 'cancelled') {
      set({ rerunQueued: false });
      void get().run();
    }
  },
  cancel() {
    if (get().status !== 'routing') return;
    set({ status: 'cancelled', error: { code: 'CANCELLED', message: 'Rute dibatalkan.' }, progress: null, rerunQueued: false });
    client?.cancel();
  },
}));
