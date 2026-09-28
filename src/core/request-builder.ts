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
  /**
   * Ganjil-genap rings for the native `exclude_polygons` field.
   *
   * Each entry is one closed ring of `[longitude, latitude]` pairs — the order and container
   * Valhalla's `parse_ring` expects (see `tools/build-gage-polygons.ts` for the source evidence
   * and the probe that confirmed it). Omitted entirely when the constraint does not apply, so a
   * scenario without it produces exactly the request this builder produced before the feature.
   */
  excludePolygons?: number[][][];
}

/** Native `date_time.type`: 1 depart_at, 2 arrive_by. */
const DATE_TIME_TYPE: Record<Exclude<TimeMode, 'now'>, 1 | 2> = { depart: 1, arrive: 2 };

/**
 * Map a scenario onto the native route request.
 * @param scenario - Waypoints, profile, time mode, profile options and any ganjil-genap rings.
 * @returns The exact request object handed to the SDK; it is pure and never mutated afterwards.
 * @remarks `language` is `id-ID` so the request matches the product's Bahasa Indonesia copy, but the
 * shipped WASM binary contains only the en-US locale and answers in English either way (the panel
 * says so). `now` omits `date_time` entirely rather than sending the current time, which is what
 * makes native use "now" with the dataset's own timezone data. `exclude_polygons` is added only when
 * the caller supplies a non-empty ring list, which the constraint planner does only for a
 * `restricted` verdict.
 */
export function buildRouteRequest(scenario: Scenario): RouteRequest {
  const request: RouteRequest = {
    locations: scenario.waypoints.map(point => ({ lat: point.lat, lon: point.lng })),
    costing: scenario.profile,
    directions_options: { language: 'id-ID', units: 'kilometers' },
  };
  if (scenario.timeMode !== 'now') request.date_time = { type: DATE_TIME_TYPE[scenario.timeMode], value: scenario.departure };
  if (Object.keys(scenario.options).length > 0) request.costing_options = { [scenario.profile]: { ...scenario.options } };
  if (scenario.excludePolygons && scenario.excludePolygons.length > 0) {
    // Neither the SDK nor the Worker rewrites this field: `validateRequest` passes it through
    // untouched (packages/valhalla-core/src/profiles.ts) and its type now admits the numeric ring
    // form. The engine's contract is the native `parse_ring`, which reads `coords[0]` as longitude
    // and `coords[1]` as latitude — verified against this build with the probe recorded in
    // tools/build-gage-polygons.ts (a nested `[[lon, lat], ...]` ring moved a route from 24.516 km
    // to 15.746 km; the comma-separated string form changed nothing at all).
    request.exclude_polygons = scenario.excludePolygons.map(ring => ring.map(([lng, lat]) => [lng, lat]));
  }
  return request;
}
