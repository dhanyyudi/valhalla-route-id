import { describe, expect, it } from 'vitest';
import type { RouteResult } from 'valhalla-browser';
import { legFigures, naiveLocal, naiveMillis, waypointTimes } from './leg-timeline';

const maneuver = (length: number, time: number) => ({ instruction: '', type: 0, length, time });

const result = { native: { trip: { summary: { length: 30, time: 2700 }, legs: [
  { shape: '', summary: { length: 12, time: 900 }, maneuvers: [maneuver(12, 900)] },
  // No summary: the leg falls back to the sum of its maneuvers.
  { shape: '', maneuvers: [maneuver(10, 1200), maneuver(8, 600)] },
] } } } as unknown as RouteResult;

describe('legFigures', () => {
  it('reads each leg summary and falls back to its maneuvers', () => {
    expect(legFigures(result)).toEqual([
      { index: 0, lengthKm: 12, timeSeconds: 900, speedKmh: 48 },
      { index: 1, lengthKm: 18, timeSeconds: 1800, speedKmh: 36 },
    ]);
  });
});

describe('naive clock values', () => {
  it('round-trips without touching the host timezone', () => {
    expect(naiveLocal(naiveMillis('2026-09-29T07:05')!)).toBe('2026-09-29T07:05');
    expect(naiveMillis('not a time')).toBeNull();
  });
});

describe('waypointTimes', () => {
  const legs = legFigures(result);

  it('starts a departure at the control value and adds each leg', () => {
    const times = waypointTimes(legs, { timeMode: 'depart', departure: '2026-09-29T07:00', startedAt: new Date() });
    expect(times.map(time => time.clock)).toEqual(['07:00', '07:15', '07:45']);
    expect(times.map(time => time.offsetSeconds)).toEqual([0, 900, 2700]);
  });

  it('ends an arrival at the control value', () => {
    const times = waypointTimes(legs, { timeMode: 'arrive', departure: '2026-09-29T08:00', startedAt: new Date() });
    expect(times.map(time => time.local)).toEqual(['2026-09-29T07:15', '2026-09-29T07:30', '2026-09-29T08:00']);
  });

  it('crosses midnight', () => {
    const times = waypointTimes(legs, { timeMode: 'depart', departure: '2026-09-29T23:30', startedAt: new Date() });
    expect(times.at(-1)?.local).toBe('2026-09-30T00:15');
  });

  it('starts a now scenario at the WIB wall clock, whatever zone the browser is in', () => {
    // 10:20 UTC is 17:20 WIB.
    const startedAt = new Date(Date.UTC(2026, 8, 29, 10, 20, 0));
    expect(waypointTimes(legs, { timeMode: 'now', departure: '', startedAt }).map(time => time.clock)).toEqual(['17:20', '17:35', '18:05']);
  });

  it('refuses an unreadable departure instead of inventing one', () => {
    expect(waypointTimes(legs, { timeMode: 'depart', departure: '', startedAt: new Date() })).toEqual([]);
  });
});
