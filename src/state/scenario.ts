import { create } from 'zustand';
import type { ProgressEvent as SdkProgress, RouteResult } from 'valhalla-browser';
import { buildRouteRequest, type Profile, type TimeMode, type Waypoint } from '../core/request-builder';
import { createRouteClient, type RouteClient } from '../router/client';

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
  result: RouteResult | null;
  status: RouteStatus;
  error: RouteFailure | null;
  progress: SdkProgress | null;
  addWaypoint(point: Waypoint): void;
  removeWaypoint(index: number): void;
  reverseWaypoints(): void;
  clearWaypoints(): void;
  setProfile(profile: Profile): void;
  setTime(timeMode: TimeMode, departure?: string): void;
  setOption(key: string, value: OptionValue | undefined): void;
  run(): Promise<void>;
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

const MANIFEST_URL: string | undefined = import.meta.env.VITE_MANIFEST_URL;

let client: RouteClient | undefined;

/**
 * The application's single SDK session, created on first use.
 * @returns The client, or undefined when the build has no `VITE_MANIFEST_URL`.
 */
function routeClient(): RouteClient | undefined {
  if (!MANIFEST_URL) return undefined;
  return (client ??= createRouteClient(MANIFEST_URL, {
    onProgress: event => useScenario.setState({ progress: event }),
  }));
}

export const useScenario = create<ScenarioState>((set, get) => ({
  waypoints: [],
  profile: 'auto',
  timeMode: 'now',
  departure: defaultDeparture(),
  options: {},
  result: null,
  status: 'idle',
  error: null,
  progress: null,

  addWaypoint(point) {
    const { waypoints } = get();
    if (waypoints.length >= MAX_WAYPOINTS) return;
    set({ waypoints: [...waypoints, point] });
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
    set({ status: 'routing', error: null, progress: null });
    try {
      const result = await active.route(buildRouteRequest({ waypoints, profile, timeMode, departure, options }));
      set({ result, status: 'done', error: null, progress: null });
    } catch (error) {
      const failure = toRouteFailure(error);
      set({ status: failure.code === 'CANCELLED' ? 'cancelled' : 'error', error: failure, progress: null });
    }
  },
  cancel() {
    if (get().status !== 'routing') return;
    set({ status: 'cancelled', error: { code: 'CANCELLED', message: 'Rute dibatalkan.' }, progress: null });
    client?.cancel();
  },
}));
