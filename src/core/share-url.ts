import type { PlateParity } from './ganjil-genap';
import type { Profile, TimeMode, Waypoint } from './request-builder';

/**
 * The scenario, as query parameters on the inspector's own URL.
 *
 * A shared link reopens the same scenario: stops, profile, time control, plate parity and the
 * costing options. The format is deliberately readable so a link can be edited by hand:
 *
 *   ?wp=-6.17540,106.82720;-6.91750,107.61910&profile=auto&time=depart&at=2026-09-29T07:00&plate=odd&opt=use_tolls:0
 *
 * Waypoints are `lat,lng`, the order Google Maps copies and the paste box reads, joined with `;`.
 * Anything unreadable is dropped rather than guessed, and the parser never throws.
 */

export interface SharedScenario {
  waypoints: Waypoint[];
  profile: Profile;
  timeMode: TimeMode;
  departure: string;
  plateParity: PlateParity;
  options: Record<string, number | boolean>;
}

const PROFILES: readonly Profile[] = ['auto', 'motorcycle', 'motor_scooter', 'truck', 'bicycle', 'pedestrian'];
const TIME_MODES: readonly TimeMode[] = ['now', 'depart', 'arrive'];
const PARITIES: readonly PlateParity[] = ['odd', 'even', 'off'];
const DEPARTURE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const OPTION_KEY = /^[a-z_]{1,32}$/;
/** Same ceiling the store enforces, so a hand-edited link cannot smuggle in more stops. */
const MAX_WAYPOINTS = 25;

/**
 * Encode a scenario as a query string (without the leading `?`).
 * @param scenario - The fields a link carries.
 * @returns Parameters in a fixed order; defaults are omitted so a plain link stays short.
 */
export function encodeScenario(scenario: SharedScenario): string {
  const parts: string[] = [];
  if (scenario.waypoints.length > 0) {
    parts.push(`wp=${scenario.waypoints.map(point => `${point.lat.toFixed(5)},${point.lng.toFixed(5)}`).join(';')}`);
  }
  if (scenario.profile !== 'auto') parts.push(`profile=${scenario.profile}`);
  if (scenario.timeMode !== 'now') parts.push(`time=${scenario.timeMode}`, `at=${encodeURIComponent(scenario.departure)}`);
  if (scenario.plateParity !== 'off') parts.push(`plate=${scenario.plateParity}`);
  const options = Object.entries(scenario.options);
  if (options.length > 0) parts.push(`opt=${options.map(([key, value]) => `${key}:${value === true ? 'true' : value}`).join(',')}`);
  return parts.join('&');
}

/**
 * Read a scenario back from a query string.
 * @param search - `location.search`, with or without the leading `?`.
 * @returns Only the fields the link carried and that parsed; an empty object for a plain URL.
 */
export function decodeScenario(search: string): Partial<SharedScenario> {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const shared: Partial<SharedScenario> = {};

  const wp = params.get('wp');
  if (wp) {
    const waypoints: Waypoint[] = [];
    for (const pair of wp.split(';').slice(0, MAX_WAYPOINTS)) {
      const [lat, lng] = pair.split(',').map(Number);
      if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) waypoints.push({ lat, lng });
    }
    if (waypoints.length > 0) shared.waypoints = waypoints;
  }

  const profile = params.get('profile') as Profile | null;
  if (profile && PROFILES.includes(profile)) shared.profile = profile;

  const time = params.get('time') as TimeMode | null;
  const at = params.get('at');
  if (time && TIME_MODES.includes(time)) {
    // A depart/arrive mode without a readable time would only be refused at run time: keep the
    // mode only when its time came with it.
    if (time === 'now') shared.timeMode = 'now';
    else if (at && DEPARTURE.test(at)) {
      shared.timeMode = time;
      shared.departure = at;
    }
  }

  const plate = params.get('plate') as PlateParity | null;
  if (plate && PARITIES.includes(plate)) shared.plateParity = plate;

  const opt = params.get('opt');
  if (opt) {
    const options: Record<string, number | boolean> = {};
    for (const entry of opt.split(',')) {
      const [key, raw] = entry.split(':');
      if (!key || !OPTION_KEY.test(key) || raw === undefined) continue;
      if (raw === 'true') options[key] = true;
      else if (raw.trim() !== '' && Number.isFinite(Number(raw))) options[key] = Number(raw);
    }
    if (Object.keys(options).length > 0) shared.options = options;
  }
  return shared;
}
