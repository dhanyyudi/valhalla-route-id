import { describe, expect, it } from 'vitest';
import artifact from '../data/gage-polygons.json';
import { REQUEST_PERIMETER_BUDGET_METERS, type CorridorPolygons } from './gage-geometry';
import { evaluationInstant, planGageRequest, wibInstant } from './gage-request';

const corridors = (artifact as unknown as { corridors: CorridorPolygons[] }).corridors;
const bufferMeters = (artifact as unknown as { bufferMeters: number }).bufferMeters;

/** A Jakarta pair on a route that crosses several corridors (the app's own demo pair). */
const JAKARTA_ROUTE: Array<[number, number]> = [[106.78038, -6.1833], [106.8763, -6.1986]];
const OUTSIDE: Array<[number, number]> = [[107.6191, -6.9175], [107.6, -6.9]];

/** The instant a WIB wall-clock string names, so the fixtures read as local time. */
const at = (text: string) => {
  const instant = wibInstant(text);
  if (!instant) throw new Error(`fixture time ${text} is not a WIB wall clock`);
  return instant;
};

function plan(overrides: Partial<Parameters<typeof planGageRequest>[0]> = {}) {
  return planGageRequest({
    plateParity: 'odd',
    profile: 'auto',
    timeMode: 'depart',
    departure: '2026-09-28T07:00',
    geometry: JAKARTA_ROUTE,
    corridors,
    bufferMeters,
    now: at('2026-09-28T07:00'),
    ...overrides,
  });
}

describe('wibInstant', () => {
  it('reads the panel value as WIB wall clock, not as UTC', () => {
    expect(wibInstant('2026-09-28T07:00')?.toISOString()).toBe('2026-09-28T00:00:00.000Z');
    expect(wibInstant('2026-09-28 17:30')?.toISOString()).toBe('2026-09-28T10:30:00.000Z');
  });

  it('reports an unreadable value instead of substituting an instant', () => {
    // A cleared `datetime-local` box is a real possibility, and the one answer this must never give
    // is the host's wall clock: the wall clock is the fallback the README promises does not exist.
    expect(wibInstant('')).toBeNull();
    expect(wibInstant('   ')).toBeNull();
    expect(wibInstant('besok pagi')).toBeNull();
  });
});

describe('evaluationInstant', () => {
  it('uses the wall clock for "now" and the panel value for depart and arrive', () => {
    const now = new Date('2026-09-28T03:00:00Z');
    expect(evaluationInstant({ timeMode: 'now', departure: '2026-09-28T07:00', now })).toBe(now);
    expect(evaluationInstant({ timeMode: 'depart', departure: '2026-09-28T07:00', now })?.toISOString())
      .toBe('2026-09-28T00:00:00.000Z');
    // `arrive` evaluates the arrival time, which is what the design asks for.
    expect(evaluationInstant({ timeMode: 'arrive', departure: '2026-09-28T09:00', now })?.toISOString())
      .toBe('2026-09-28T02:00:00.000Z');
    // An unreadable panel value names no instant: not the wall clock, and not the departure time.
    expect(evaluationInstant({ timeMode: 'depart', departure: '', now })).toBeNull();
    expect(evaluationInstant({ timeMode: 'arrive', departure: 'besok', now })).toBeNull();
  });
});

describe('planGageRequest', () => {
  it('leaves the request untouched when the plate parity is Nonaktif', () => {
    const off = plan({ plateParity: 'off' });
    expect(off.restricted).toBe(false);
    expect(off.evaluation?.status).toBe('inactive_time');
    expect(off.excludePolygons).toEqual([]);
    expect(off.perimeterMeters).toBe(0);
    expect(off.excluded).toEqual([]);
  });

  it('leaves the request untouched outside the active windows and on weekends', () => {
    for (const departure of ['2026-09-28T05:59', '2026-09-28T10:00', '2026-09-28T15:59', '2026-09-28T21:00', '2026-10-03T07:00']) {
      const outside = plan({ departure });
      expect(outside.restricted).toBe(false);
      expect(outside.excludePolygons).toEqual([]);
    }
  });

  it('leaves the request untouched when the plate parity matches the date', () => {
    // 2026-09-28 is the 28th: an even date.
    const matching = plan({ departure: '2026-09-28T07:00', plateParity: 'even' });
    expect(matching.evaluation?.status).toBe('allowed');
    expect(matching.excludePolygons).toEqual([]);
  });

  it('leaves the request untouched for an exempt profile, whatever the toggle says', () => {
    for (const profile of ['motorcycle', 'motor_scooter'] as const) {
      const exempt = plan({ profile });
      expect(exempt.evaluation?.status).toBe('exempt_profile');
      expect(exempt.excludePolygons).toEqual([]);
      expect(exempt.evaluation?.reason).toContain('dibebaskan');
    }
  });

  it('leaves the request untouched when every point is outside Jakarta', () => {
    const abroad = plan({ geometry: OUTSIDE });
    expect(abroad.restricted).toBe(false);
    expect(abroad.excludePolygons).toEqual([]);
  });

  it('adds [lon, lat] rings, within Valhalla budget, when the verdict is restricted', () => {
    const restricted = plan();
    expect(restricted.restricted).toBe(true);
    expect(restricted.evaluation?.status).toBe('restricted');
    expect(restricted.excludePolygons.length).toBe(restricted.ringsSent);
    expect(restricted.excludePolygons.length).toBeGreaterThan(0);
    expect(restricted.perimeterMeters).toBeLessThanOrEqual(REQUEST_PERIMETER_BUDGET_METERS);
    // Valhalla's own hard limit: the summed ring perimeter of one request, 10,000 m here.
    expect(restricted.perimeterMeters).toBeLessThan(10_000);
    for (const ring of restricted.excludePolygons) {
      expect(ring.length).toBeGreaterThanOrEqual(4);
      expect(ring[0]).toEqual(ring[ring.length - 1]);
      for (const [lng, lat] of ring) {
        // Longitude first: every ring must sit inside Jakarta's longitude band, not its latitude's.
        expect(lng).toBeGreaterThan(106.6);
        expect(lng).toBeLessThan(107.0);
        expect(lat).toBeGreaterThan(-6.4);
        expect(lat).toBeLessThan(-6.0);
      }
    }
  });

  it('names the corridors it is excluding and the ones it only partly covers', () => {
    const restricted = plan();
    const names = restricted.excluded.map(corridor => corridor.name);
    // The excluded corridors are the ones whose rings were sent in full.
    const sentIds = new Set(restricted.excluded.map(corridor => corridor.id));
    expect(sentIds.size).toBe(restricted.excluded.length);
    expect(names.length).toBeGreaterThan(0);
    // Whatever the budget refused is still visible to the panel, never silently dropped, and it says
    // which chunk went rather than implying the whole corridor did.
    expect(restricted.partial.every(entry => !sentIds.has(entry.corridor.id))).toBe(true);
    for (const entry of restricted.partial) {
      expect(entry.ringIndexes.length).toBeGreaterThan(0);
      expect(entry.ringIndexes.every(index => index >= 0 && index < entry.corridor.rings.length)).toBe(true);
    }
  });

  it('evaluates "now" against the injected clock rather than the host time', () => {
    const restricted = plan({ timeMode: 'now', now: at('2026-09-28T17:30'), departure: '2026-09-28T17:30' });
    expect(restricted.evaluation?.status).toBe('restricted');
    expect(restricted.evaluation?.parts.hour).toBe(17);
    const inactive = plan({ timeMode: 'now', now: at('2026-09-28T12:00'), departure: '2026-09-28T07:00' });
    // 07:00 in the box would be restricted; the clock says noon, so it is not.
    expect(inactive.excludePolygons).toEqual([]);
  });

  it('refuses to plan when the panel time cannot be read, rather than using the wall clock', () => {
    // The M-6 case: a cleared `datetime-local` box. 17:30 on the injected clock *would* be
    // restricted, so a fallback to `now` would show a verdict here — the refusal is the point.
    for (const departure of ['', '   ', 'besok pagi']) {
      const refused = plan({ departure, now: at('2026-09-28T17:30') });
      expect(refused.evaluation).toBeNull();
      expect(refused.refusal).toContain('tidak terbaca');
      expect(refused.restricted).toBe(false);
      expect(refused.excludePolygons).toEqual([]);
      expect(refused.ringsSent).toBe(0);
      expect(refused.perimeterMeters).toBe(0);
    }
    // A "route now" scenario names no time and keeps working, restriction and all.
    const now = plan({ timeMode: 'now', departure: '', now: at('2026-09-28T17:30') });
    expect(now.evaluation?.status).toBe('restricted');
    expect(now.excludePolygons.length).toBeGreaterThan(0);
  });
});
