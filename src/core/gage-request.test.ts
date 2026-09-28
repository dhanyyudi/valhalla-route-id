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
const at = (text: string) => wibInstant(text, new Date('2026-01-01T00:00:00Z'));

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
    expect(wibInstant('2026-09-28T07:00', new Date(0)).toISOString()).toBe('2026-09-28T00:00:00.000Z');
    expect(wibInstant('2026-09-28 17:30', new Date(0)).toISOString()).toBe('2026-09-28T10:30:00.000Z');
  });

  it('falls back rather than routing blind on an unparseable value', () => {
    const fallback = new Date('2026-09-28T00:00:00Z');
    expect(wibInstant('', fallback)).toBe(fallback);
    expect(wibInstant('besok pagi', fallback)).toBe(fallback);
  });
});

describe('evaluationInstant', () => {
  it('uses the wall clock for "now" and the panel value for depart and arrive', () => {
    const now = new Date('2026-09-28T03:00:00Z');
    expect(evaluationInstant({ timeMode: 'now', departure: '2026-09-28T07:00', now })).toBe(now);
    expect(evaluationInstant({ timeMode: 'depart', departure: '2026-09-28T07:00', now }).toISOString())
      .toBe('2026-09-28T00:00:00.000Z');
    // `arrive` evaluates the arrival time, which is what the design asks for.
    expect(evaluationInstant({ timeMode: 'arrive', departure: '2026-09-28T09:00', now }).toISOString())
      .toBe('2026-09-28T02:00:00.000Z');
  });
});

describe('planGageRequest', () => {
  it('leaves the request untouched when the plate parity is Nonaktif', () => {
    const off = plan({ plateParity: 'off' });
    expect(off.restricted).toBe(false);
    expect(off.evaluation.status).toBe('inactive_time');
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
    expect(matching.evaluation.status).toBe('allowed');
    expect(matching.excludePolygons).toEqual([]);
  });

  it('leaves the request untouched for an exempt profile, whatever the toggle says', () => {
    for (const profile of ['motorcycle', 'motor_scooter'] as const) {
      const exempt = plan({ profile });
      expect(exempt.evaluation.status).toBe('exempt_profile');
      expect(exempt.excludePolygons).toEqual([]);
      expect(exempt.evaluation.reason).toContain('dibebaskan');
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
    expect(restricted.evaluation.status).toBe('restricted');
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
    // Whatever the budget refused is still visible to the panel, never silently dropped.
    expect(restricted.partial.every(corridor => !sentIds.has(corridor.id))).toBe(true);
  });

  it('evaluates "now" against the injected clock rather than the host time', () => {
    const restricted = plan({ timeMode: 'now', now: at('2026-09-28T17:30'), departure: '2026-09-28T17:30' });
    expect(restricted.evaluation.status).toBe('restricted');
    expect(restricted.evaluation.parts.hour).toBe(17);
    const inactive = plan({ timeMode: 'now', now: at('2026-09-28T12:00'), departure: '2026-09-28T07:00' });
    // 07:00 in the box would be restricted; the clock says noon, so it is not.
    expect(inactive.excludePolygons).toEqual([]);
  });
});
