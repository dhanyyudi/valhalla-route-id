/**
 * The ganjil-genap (odd-even) rule for Jakarta, as a pure function of an injected time.
 *
 * Nothing here reads the wall clock or the environment: the caller passes the scenario's simulated
 * departure time (or, for an `arrive_by` request, its arrival time), so re-opening a shared
 * scenario evaluates the same rule it did when it was created.
 *
 * Ported from the source implementation in the TRAYEK repository (`lib/rules/ganjil-genap.ts` and
 * `lib/rules/ganjil-genap-time.ts`): Pergub DKI 88/2019 exempts motorcycles, the windows are
 * 06:00–10:00 and 16:00–21:00 WIB on weekdays, and the rule is scoped to Jakarta/Jabodetabek.
 */

/** Plate parity as the user declares it; `off` means "evaluate nothing, send no polygons". */
export type PlateParity = 'odd' | 'even' | 'off';

/** Outcome of one evaluation. */
export type GanjilGenapStatus =
  /** The vehicle class is exempt by regulation (motorcycle, motor scooter). */
  | 'exempt_profile'
  /** The user turned the constraint off for this scenario. */
  | 'inactive_time'
  /** A weekday inside an active window, but the plate parity matches the date: may enter. */
  | 'allowed'
  /** The parity differs inside an active window: the corridors must be avoided. */
  | 'restricted';

/** One daily enforcement window, WIB, `[startHour, endHour)` in 24-hour time. */
export interface ActiveWindow {
  /** WIB hour the window opens, inclusive. */
  startHour: number;
  /** WIB hour the window closes, exclusive. */
  endHour: number;
  /** Indonesian label the panel shows, e.g. `Pagi`. */
  label: string;
}

/**
 * Enforcement windows, WIB.
 *
 * Exported because both the rule and the UI quote them; the boundaries are half-open, so 10:00 WIB
 * is outside the morning window and 16:00 is inside the evening one.
 */
export const ACTIVE_WINDOWS: readonly ActiveWindow[] = [
  { startHour: 6, endHour: 10, label: 'Pagi' },
  { startHour: 16, endHour: 21, label: 'Sore' },
];

/**
 * Jakarta/Jabodetabek bounding box, the one the source implementation uses.
 * @remarks A scenario whose waypoints all fall outside it cannot meet a Jakarta corridor.
 */
export const JAKARTA_BBOX = { minLng: 106.4, minLat: -6.75, maxLng: 107.2, maxLat: -5.8 } as const;

/** Profiles the regulation exempts: two- and three-wheelers, per Pergub DKI 88/2019. */
export const EXEMPT_PROFILES: readonly string[] = ['motorcycle', 'motor_scooter'];

/** WIB is UTC+7 with no daylight saving; every component below is read in UTC after the shift. */
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Calendar facts about one instant, in WIB. */
export interface WibParts {
  /** 0 = Sunday … 6 = Saturday, in WIB. */
  dayOfWeek: number;
  /** Hour of day in WIB, 0–23. */
  hour: number;
  /** Minute of hour in WIB, 0–59. */
  minute: number;
  /** Day of month in WIB, 1–31. */
  dateNumber: number;
  /** `odd` when the day of month is odd, `even` otherwise. */
  dateParity: Exclude<PlateParity, 'off'>;
  /** `YYYY-MM-DD` in WIB, for messages and tests. */
  isoDate: string;
}

/**
 * Split an instant into WIB calendar parts.
 *
 * Computed from the injected `Date` with UTC getters after a fixed +7 h shift, so the answer does
 * not depend on the machine's timezone or on `TZ` being set: 2026-09-28T00:00Z is 07:00 WIB on a
 * Monday whatever the host thinks the local time is.
 *
 * @param at - The instant to describe.
 * @returns WIB day of week, hour, minute, date number, date parity and ISO date.
 */
export function wibParts(at: Date): WibParts {
  const shifted = new Date(at.getTime() + WIB_OFFSET_MS);
  const dateNumber = shifted.getUTCDate();
  const pad = (value: number) => String(value).padStart(2, '0');
  return {
    dayOfWeek: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    dateNumber,
    dateParity: dateNumber % 2 === 0 ? 'even' : 'odd',
    isoDate: `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(dateNumber)}`,
  };
}

/**
 * Is ganjil-genap enforced at this instant?
 * @param at - The instant to test, in WIB.
 * @returns The active window, or null on a weekend or outside both windows.
 */
export function activeWindowAt(at: Date): ActiveWindow | null {
  const { dayOfWeek, hour } = wibParts(at);
  if (dayOfWeek === 0 || dayOfWeek === 6) return null;
  return ACTIVE_WINDOWS.find(window => hour >= window.startHour && hour < window.endHour) ?? null;
}

/** Is a point inside the Jakarta/Jabodetabek box the rule is scoped to? */
export function isInJakartaRegion(point: { lng: number; lat: number }): boolean {
  return point.lng >= JAKARTA_BBOX.minLng && point.lng <= JAKARTA_BBOX.maxLng
    && point.lat >= JAKARTA_BBOX.minLat && point.lat <= JAKARTA_BBOX.maxLat;
}

/** Everything the rule needs; all of it comes from the scenario, none of it from the clock. */
export interface GanjilGenapInput {
  /** Simulated departure time — or arrival time for an `arrive_by` scenario. */
  at: Date;
  /** Active routing profile, e.g. `auto`, `motorcycle`. */
  profile: string;
  /** The parity the user declared for this scenario. */
  plateParity: PlateParity;
  /**
   * Planned stops or route geometry as `[lng, lat]`.
   *
   * Optional: without it the rule answers for Jakarta in general. With it, a scenario where every
   * point is outside the Jakarta box reports `inactive_time` with the region named in the reason,
   * instead of claiming a restriction hundreds of kilometres away.
   */
  route?: Array<[number, number]>;
}

/** The rule's verdict: what applies, why in Indonesian, and inside which window. */
export interface GanjilGenapEvaluation {
  status: GanjilGenapStatus;
  /** Indonesian sentence the panel shows verbatim. */
  reason: string;
  /** The window in force, or null when the constraint is not active. */
  window: ActiveWindow | null;
  /** WIB calendar facts the verdict was computed from, for the panel and for tests. */
  parts: WibParts;
}

/** `Ganjil`/`Genap` in Indonesian, for messages. */
function parityLabel(parity: Exclude<PlateParity, 'off'>): string {
  return parity === 'odd' ? 'ganjil' : 'genap';
}

/**
 * Evaluate the constraint for one scenario.
 *
 * Decision order: an exempt vehicle class wins over everything (the regulation exempts it whatever
 * the time and plate, and the panel says so rather than silently ignoring the toggle); then the
 * user's `off`; then the enforcement window; then the region; then plate parity against the date.
 *
 * @param input - Simulated time, profile, declared plate parity and (optionally) the route or stops.
 * @returns Status, Indonesian reason, the window in force and the WIB parts behind it.
 */
export function evaluateGanjilGenap(input: GanjilGenapInput): GanjilGenapEvaluation {
  const parts = wibParts(input.at);
  const schedule = 'Berlaku Senin–Jumat 06:00–10:00 dan 16:00–21:00 WIB.';

  if (EXEMPT_PROFILES.includes(input.profile)) {
    return {
      status: 'exempt_profile',
      reason: `Profil ${input.profile === 'motorcycle' ? 'motor' : 'skuter'} dibebaskan dari ganjil-genap (Pergub DKI 88/2019), jadi ruas jalan ganjil-genap tidak dikecualikan. ${schedule}`,
      window: null,
      parts,
    };
  }
  if (input.plateParity === 'off') {
    return {
      status: 'inactive_time',
      reason: `Ganjil-genap dimatikan untuk skenario ini, jadi tidak ada ruas jalan yang dikecualikan. ${schedule}`,
      window: null,
      parts,
    };
  }
  const window = activeWindowAt(input.at);
  if (!window) {
    const weekend = parts.dayOfWeek === 0 || parts.dayOfWeek === 6;
    return {
      status: 'inactive_time',
      reason: weekend
        ? `Ganjil-genap tidak berlaku pada akhir pekan (${parts.isoDate}), jadi tidak ada ruas jalan yang dikecualikan. ${schedule}`
        : `Di luar jam berlaku WIB (${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')} pada ${parts.isoDate}), jadi tidak ada ruas jalan yang dikecualikan. ${schedule}`,
      window: null,
      parts,
    };
  }
  if (input.route && input.route.length > 0 && !input.route.some(([lng, lat]) => isInJakartaRegion({ lng, lat }))) {
    return {
      status: 'inactive_time',
      reason: `Semua titik berada di luar area Jakarta/Jabodetabek, jadi ganjil-genap tidak berlaku meski sedang jam aktif. ${schedule}`,
      window: null,
      parts,
    };
  }
  if (input.plateParity === parts.dateParity) {
    return {
      status: 'allowed',
      reason: `Plat ${parityLabel(input.plateParity)} boleh melintas: tanggal ${parts.dateNumber} juga ${parityLabel(parts.dateParity)}. Sesi ${window.label.toLowerCase()} ${window.startHour}:00–${window.endHour}:00 WIB.`,
      window,
      parts,
    };
  }
  return {
    status: 'restricted',
    reason: `Plat ${parityLabel(input.plateParity)} dilarang melintas: tanggal ${parts.dateNumber} ${parityLabel(parts.dateParity)}. Ruas jalan ganjil-genap dikecualikan untuk permintaan ini (sesi ${window.label.toLowerCase()} ${window.startHour}:00–${window.endHour}:00 WIB).`,
    window,
    parts,
  };
}
