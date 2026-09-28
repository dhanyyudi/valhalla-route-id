/**
 * The seam between a scenario and the ganjil-genap constraint.
 *
 * One function decides everything the UI and the request need: the rule's verdict for the scenario's
 * simulated time, which corridors to exclude (only when the verdict is `restricted`), the rings to
 * send, and the corridors the budget could not cover. Keeping it in one pure place is what makes
 * "Nonaktif changes nothing" checkable — with the constraint off, the exclusion list is empty and
 * the request builder produces exactly the request it produced before this feature existed.
 */
import { findCorridorCrossings, type CrossingReport } from './gage-crossing';
import {
  REQUEST_PERIMETER_BUDGET_METERS,
  encodeExcludePolygons,
  selectCorridorsForRoute,
  type CorridorPolygons,
  type LngLat,
} from './gage-geometry';
import { evaluateGanjilGenap, type GanjilGenapEvaluation, type PlateParity } from './ganjil-genap';
import type { Profile, TimeMode } from './request-builder';

/** Inputs the planner needs from a scenario. */
export interface GageRequestInput {
  /** Plate parity the user declared; `off` means "no constraint for this scenario". */
  plateParity: PlateParity;
  /** Active profile; motorcycles and scooters are exempt by regulation. */
  profile: Profile;
  /** How the time control is set: now, a departure time, or an arrival time. */
  timeMode: TimeMode;
  /** `datetime-local` value from the panel; interpreted as WIB wall-clock, not the host's zone. */
  departure: string;
  /** Route geometry (`[lng, lat]`) when a route has been calculated; otherwise the planned stops. */
  geometry: LngLat[];
  /** The generated corridors; defaults to the bundled artifact. */
  corridors: CorridorPolygons[];
  /** Buffer half-width in metres; defaults to the artifact's declared 35 m. */
  bufferMeters: number;
  /** Wall clock, injected so tests and the state store can pin it. Used only for a `now` scenario. */
  now: Date;
  /** Per-request ring-perimeter budget; defaults to the packer's own budget. */
  budgetMeters?: number;
}

/** Indonesian reason shown when the time control holds no parseable WIB wall clock. */
export const UNPARSEABLE_TIME_MESSAGE =
  'Waktu berangkat/tiba tidak terbaca, jadi ganjil-genap tidak dievaluasi dan permintaan tidak membawa exclude_polygons. Isi waktu yang valid atau pilih "Sekarang".';

/** Everything the panel and the request builder need to know about the constraint. */
export interface GagePlan {
  /**
   * The rule's verdict: status, Indonesian reason and the window in force.
   *
   * `null` when no verdict could be computed — today, only an empty or unparseable departure or
   * arrival time. It is null rather than a verdict for "now" on purpose: evaluating at the wall
   * clock when the panel names a time is the one substitution this feature promises never to make.
   */
  evaluation: GanjilGenapEvaluation | null;
  /** Why the plan carries no evaluation, for the panel to show verbatim; null on a normal plan. */
  refusal: string | null;
  /** Corridors the geometry in hand already runs through, before any exclusion. */
  crossings: CrossingReport;
  /** Corridors inside the route's reach that the request asks Valhalla to avoid. */
  excluded: CorridorPolygons[];
  /**
   * Corridors only partly covered: the budget paid for some of their rings, not all.
   *
   * Without the ring indices the panel could only say "sebagian: Jl. Sudirman", which reads as though
   * the whole corridor were excluded. Measured against the deployed Worker, the panel did exactly
   * that while the ring actually sent belonged to Jl. Rasuna Said — a report that names the wrong
   * street is worse than one that names none.
   */
  partial: Array<{ corridor: CorridorPolygons; ringIndexes: number[] }>;
  /** How many rings the request carries. */
  ringsSent: number;
  /**
   * Rows for `request.exclude_polygons` — empty whenever the constraint does not apply.
   *
   * Valhalla's parser reads each row as a ring of `[longitude, latitude]` pairs (see
   * `tools/build-gage-polygons.ts` for the source evidence).
   */
  excludePolygons: number[][][];
  /** Summed perimeter of `excludePolygons`, in metres, against Valhalla's 10,000 m service limit. */
  perimeterMeters: number;
  /** True only when the constraint is active, the profile is not exempt, and parity differs. */
  restricted: boolean;
}

/**
 * Turn a `datetime-local` string into the instant it names in WIB.
 *
 * The panel's value is the dataset's local wall clock, and WIB is UTC+7 with no daylight saving, so
 * `2026-09-28T07:00` is 2026-09-28T00:00:00Z. Parsing it as UTC instead (which is what `Date`'s
 * ISO fallback does for a value without a zone suffix) would evaluate the rule seven hours early —
 * 07:00 would be judged at midnight WIB, outside every window.
 *
 * @param value - `YYYY-MM-DDTHH:MM` from the panel, optionally with seconds.
 * @returns The instant the wall clock names in WIB, or `null` when the value is not a WIB wall
 *   clock. A cleared `datetime-local` box is a real possibility, and the one thing this must never
 *   do is substitute the host's wall clock: the caller refuses to plan instead (`planGageRequest`),
 *   so a malformed value cannot route with a verdict the user never asked for.
 */
export function wibInstant(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value.trim());
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(part => Number(part ?? 0));
  const instant = new Date(Date.UTC(year, month - 1, day, hour - 7, minute, second));
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/**
 * The instant the constraint is evaluated at, matching the time the route is requested for.
 * @param input - Scenario time control, the panel's value and the wall clock.
 * @returns `now` for a "route now" scenario; the departure time for `depart`; the arrival time for
 *   `arrive_by`, exactly as the design requires; `null` when the panel value is not a WIB wall clock.
 */
export function evaluationInstant(input: Pick<GageRequestInput, 'timeMode' | 'departure' | 'now'>): Date | null {
  if (input.timeMode === 'now') return input.now;
  return wibInstant(input.departure);
}

/**
 * The plan a scenario gets when its departure or arrival time cannot be read.
 *
 * `evaluation: null` is the whole point: there is no verdict to show, the request carries no rings,
 * and the panel says why rather than evaluating the rule at some other instant. `run()` refuses on
 * this plan too, so the reason is never only cosmetic.
 *
 * @returns A plan with no evaluation, no crossings and no rings.
 */
export function refusedGagePlan(message: string): GagePlan {
  return {
    evaluation: null,
    refusal: message,
    crossings: { corridors: [], count: 0 },
    excluded: [],
    partial: [],
    ringsSent: 0,
    excludePolygons: [],
    perimeterMeters: 0,
    restricted: false,
  };
}

/**
 * Plan the constraint for one scenario.
 *
 * @param input - Parity, profile, time control, geometry to test and the corridor data.
 * @returns The verdict, the corridors to exclude, the native rows to send and the budget report; a
 *   refusal plan (`evaluation: null`, `refusal` set) when the time control names no parseable time.
 * @remarks `excludePolygons` is non-empty only for a `restricted` verdict. An exempt profile, a
 *   time outside the windows, a matching parity and "Nonaktif" all return an empty list, which is
 *   what keeps an existing scenario's request byte-identical to the pre-feature build.
 */
export function planGageRequest(input: GageRequestInput): GagePlan {
  const instant = evaluationInstant(input);
  if (!instant) return refusedGagePlan(UNPARSEABLE_TIME_MESSAGE);
  const evaluation = evaluateGanjilGenap({
    at: instant,
    profile: input.profile,
    plateParity: input.plateParity,
    route: input.geometry,
  });

  // The corridors the geometry already runs through. The selector ranks by this set and the panel
  // reports it, so the two can never disagree about what counts as "on this route".
  const crossings = findCorridorCrossings(input.geometry, input.corridors);
  if (evaluation.status !== 'restricted') {
    return { evaluation, refusal: null, crossings, excluded: [], partial: [], ringsSent: 0, excludePolygons: [], perimeterMeters: 0, restricted: false };
  }

  const selection = selectCorridorsForRoute({
    route: input.geometry,
    corridors: input.corridors,
    bufferMeters: input.bufferMeters,
    budgetMeters: input.budgetMeters ?? REQUEST_PERIMETER_BUDGET_METERS,
    crossed: crossings.corridors,
  });
  return {
    evaluation,
    refusal: null,
    crossings,
    excluded: selection.selected,
    partial: selection.omitted.map(corridor => ({
      corridor,
      ringIndexes: selection.rings.filter(entry => entry.corridor.id === corridor.id).map(entry => entry.ringIndex),
    })),
    ringsSent: selection.rings.length,
    excludePolygons: encodeExcludePolygons(selection.rings),
    perimeterMeters: selection.perimeterMeters,
    restricted: true,
  };
}
