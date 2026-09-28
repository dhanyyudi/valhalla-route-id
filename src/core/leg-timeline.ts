import type { RouteResult } from 'valhalla-browser';
import type { TimeMode } from './request-builder';

/**
 * Per-leg figures and per-waypoint clock times for one native route.
 *
 * Every number comes from the response: a leg's distance and time are the native `legs[].summary`
 * values (summed from its maneuvers when a leg carries no summary), and a waypoint's clock time is
 * the run's start time plus the travel time of every leg before it. Nothing here models a dwell
 * time, so the arrival at a stop and the departure from it are the same minute.
 *
 * Clock arithmetic is done on the naive wall-clock value the time control holds (`YYYY-MM-DDTHH:MM`,
 * "waktu lokal dataset"), never through the host's timezone: the value is read and written as if it
 * were UTC, which shifts nothing, so a Jakarta scenario opened in Tokyo still reads 07:00 at 07:00.
 */

/** One leg between waypoint `index` and waypoint `index + 1`. */
export interface LegFigures {
  index: number;
  /** Kilometres, as native reports them. */
  lengthKm: number;
  /** Seconds, as native reports them. */
  timeSeconds: number;
  /** Mean speed over the leg in km/h; zero when the leg takes no time. */
  speedKmh: number;
}

/** Clock time at one waypoint, as the naive local `YYYY-MM-DDTHH:MM` value plus a display form. */
export interface WaypointTime {
  index: number;
  /** Seconds after the first waypoint. */
  offsetSeconds: number;
  /** `YYYY-MM-DDTHH:MM`, in the same wall clock as the departure control. */
  local: string;
  /** `HH:MM`, for badges. */
  clock: string;
}

/** Everything a run started with that the clock times depend on, captured when it started. */
export interface RunClock {
  timeMode: TimeMode;
  /** The departure/arrival control's value at run time. */
  departure: string;
  /** Host wall clock at run time, used only for a `now` scenario. */
  startedAt: Date;
}

interface NativeLegSummary { length?: unknown; time?: unknown }

/**
 * Distance, time and mean speed for each leg of a route.
 * @param result - The native route result.
 * @returns One entry per leg, in travel order.
 */
export function legFigures(result: RouteResult): LegFigures[] {
  return result.native.trip.legs.map((leg, index) => {
    const summary = (leg as { summary?: NativeLegSummary }).summary;
    const lengthKm = typeof summary?.length === 'number' ? summary.length : leg.maneuvers.reduce((sum, maneuver) => sum + maneuver.length, 0);
    const timeSeconds = typeof summary?.time === 'number' ? summary.time : leg.maneuvers.reduce((sum, maneuver) => sum + maneuver.time, 0);
    return { index, lengthKm, timeSeconds, speedKmh: timeSeconds > 0 ? lengthKm / (timeSeconds / 3600) : 0 };
  });
}

const pad = (value: number) => String(value).padStart(2, '0');

/** Read a `YYYY-MM-DDTHH:MM` value as naive milliseconds (UTC is only the carrier, not a zone). */
export function naiveMillis(local: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  const millis = Date.UTC(year, month - 1, day, hour, minute);
  return Number.isFinite(millis) ? millis : null;
}

/** Inverse of {@link naiveMillis}. */
export function naiveLocal(millis: number): string {
  const at = new Date(millis);
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}T${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
}

/** The host's wall clock as a naive `YYYY-MM-DDTHH:MM` value. */
function hostLocal(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * Clock time at every waypoint of a route.
 * @param legs - Leg figures from {@link legFigures}.
 * @param clock - What the run started with.
 * @returns One entry per waypoint (legs + 1), or an empty list when the start cannot be read.
 * @remarks `depart` starts the clock at the control's value, `arrive` ends it there (so the first
 *   waypoint is the arrival minus the whole trip), and `now` starts it at the host's wall clock
 *   when the run began.
 */
export function waypointTimes(legs: LegFigures[], clock: RunClock): WaypointTime[] {
  const total = legs.reduce((sum, leg) => sum + leg.timeSeconds, 0);
  const anchor = clock.timeMode === 'now' ? naiveMillis(hostLocal(clock.startedAt)) : naiveMillis(clock.departure);
  if (anchor === null) return [];
  // Seconds inside the host minute are kept for `now`, so a run at 07:00:50 does not read 07:00.
  const seconds = clock.timeMode === 'now' ? clock.startedAt.getSeconds() : 0;
  const start = anchor + seconds * 1000 - (clock.timeMode === 'arrive' ? total * 1000 : 0);
  const offsets = [0];
  for (const leg of legs) offsets.push(offsets[offsets.length - 1] + leg.timeSeconds);
  return offsets.map((offsetSeconds, index) => {
    // Rounded to the nearest minute, the precision the control itself has.
    const local = naiveLocal(Math.round((start + offsetSeconds * 1000) / 60000) * 60000);
    return { index, offsetSeconds, local, clock: local.slice(11, 16) };
  });
}
