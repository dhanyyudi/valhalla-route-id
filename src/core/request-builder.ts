import type { RouteRequest } from 'valhalla-browser';

/** Road profiles this inspector exposes; every one is advertised by the Indonesia release. */
export type Profile = 'auto' | 'motorcycle' | 'motor_scooter' | 'truck' | 'bicycle' | 'pedestrian';

/** How the request's `date_time` is derived: no time, a departure time, or an arrival time. */
export type TimeMode = 'now' | 'depart' | 'arrive';

/** A route stop. `label` is display-only; it is never sent to Valhalla. */
export interface Waypoint { lng: number; lat: number; label?: string }

/** Everything one route request needs, independent of React, the SDK and the map. */
export interface Scenario {
  waypoints: Waypoint[];
  profile: Profile;
  timeMode: TimeMode;
  departure: string;
  /** Costing options for the active profile only; keys must be valid for it or the SDK rejects the request. */
  options: Record<string, number | boolean | string>;
}

/** Native `date_time.type`: 1 depart_at, 2 arrive_by. */
const DATE_TIME_TYPE: Record<Exclude<TimeMode, 'now'>, 1 | 2> = { depart: 1, arrive: 2 };

/**
 * Map a scenario onto the native route request.
 * @param scenario - Waypoints, profile, time mode and profile options from the UI.
 * @returns The exact request object handed to the SDK; it is pure and never mutated afterwards.
 * @remarks `language` is `id-ID` so the request matches the product's Bahasa Indonesia copy, but the
 * shipped WASM binary contains only the en-US locale and answers in English either way (the panel
 * says so). `now` omits `date_time` entirely rather than sending the current time, which is what
 * makes native use "now" with the dataset's own timezone data.
 */
export function buildRouteRequest(scenario: Scenario): RouteRequest {
  const request: RouteRequest = {
    locations: scenario.waypoints.map(point => ({ lat: point.lat, lon: point.lng })),
    costing: scenario.profile,
    directions_options: { language: 'id-ID', units: 'kilometers' },
  };
  if (scenario.timeMode !== 'now') request.date_time = { type: DATE_TIME_TYPE[scenario.timeMode], value: scenario.departure };
  if (Object.keys(scenario.options).length > 0) request.costing_options = { [scenario.profile]: { ...scenario.options } };
  return request;
}
