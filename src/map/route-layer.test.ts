import { describe, expect, it } from 'vitest';
import { decodePolyline6, legColor, legLabelText, pointAlong, routeCoordinates, routeTrack, trackAt } from './route-layer';
import type { RouteResult } from 'valhalla-browser';

/** Independent encoder, used only to prove the decoder round-trips. */
function encodePolyline6(points: [number, number][]): string {
  let lat = 0, lng = 0;
  let out = '';
  const encode = (value: number) => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    let chunk = '';
    while (v >= 0x20) { chunk += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return chunk + String.fromCharCode(v + 63);
  };
  for (const [pointLng, pointLat] of points) {
    const lat6 = Math.round(pointLat * 1e6), lng6 = Math.round(pointLng * 1e6);
    out += encode(lat6 - lat) + encode(lng6 - lng);
    lat = lat6; lng = lng6;
  }
  return out;
}

describe('decodePolyline6', () => {
  it('decodes the origin', () => {
    expect(decodePolyline6('??')).toEqual([[0, 0]]);
  });

  it('round-trips a west/south-bound Indonesian line', () => {
    const points: [number, number][] = [[106.8272, -6.1754], [106.9, -6.3], [107.2, -6.55], [107.6191, -6.9175]];
    expect(decodePolyline6(encodePolyline6(points))).toEqual(points);
  });

  it('decodes the snapped start of a recorded Jakarta–Bandung leg', () => {
    // The first 120 characters of `trip.legs[0].shape` from tools/verify/wasm.jsonl case 2. Native
    // starts the shape at the edge it snapped the input location to, so this is within a few
    // hundred metres of Monas rather than exactly on it.
    const prefix = 'l{wwJa{iwjEwBbBaClAwCz@_CXcBDkEEcC[wR{CyQmCeDYoCG_CJmBb@gB~@yAvAsBhCkArBy@|Bc@pBYbCQbDUt}@?zNAzJC~RqBxCmAt@qATuACkAUeBkA';
    const [[lng, lat]] = decodePolyline6(prefix);
    expect(lat).toBeCloseTo(-6.1754, 1);
    expect(lng).toBeCloseTo(106.8272, 1);
    expect(lat).toBeLessThan(0);
    expect(lng).toBeGreaterThan(100);
  });
});

describe('routeCoordinates', () => {
  it('concatenates every leg in travel order', () => {
    const result = { native: { trip: { legs: [
      { shape: encodePolyline6([[106.8272, -6.1754], [106.9, -6.3]]) },
      { shape: encodePolyline6([[106.9, -6.3], [107.6191, -6.9175]]) },
    ] } } } as unknown as RouteResult;
    expect(routeCoordinates(result)).toEqual([[106.8272, -6.1754], [106.9, -6.3], [106.9, -6.3], [107.6191, -6.9175]]);
  });
});

describe('routeTrack', () => {
  const maneuver = (time: number, begin: number, end: number) => ({ instruction: '', type: 0, length: 0, time, begin_shape_index: begin, end_shape_index: end });
  // Two equal-length segments, the second one three times slower, then a second leg.
  const result = { native: { trip: { legs: [
    { shape: encodePolyline6([[106.80, -6.20], [106.81, -6.20], [106.82, -6.20]]), maneuvers: [maneuver(10, 0, 1), maneuver(30, 1, 2), maneuver(0, 2, 2)] },
    { shape: encodePolyline6([[106.82, -6.20], [106.82, -6.21]]), maneuvers: [{ instruction: '', type: 0, length: 0, time: 20 }] },
  ] } } } as unknown as RouteResult;

  it('times every vertex from its maneuver, then falls back to distance', () => {
    const track = routeTrack(result);
    expect(track.legs[0].times).toEqual([0, 10, 40]);
    // The second leg has no shape indexes, so its 20 s is spread by distance from where leg 1 ended.
    expect(track.legs[1].times).toEqual([40, 60]);
    expect(track.totalSeconds).toBe(60);
  });

  it('places the vehicle by trip time, not by distance', () => {
    const track = routeTrack(result);
    const at = trackAt(track, 25);
    // 25 s is halfway through the slow second segment: 106.81 + 0.5 * 0.01.
    expect(at.leg).toBe(0);
    expect(at.head?.[0]).toBeCloseTo(106.815, 6);
    expect(at.legs[1]).toEqual([]);
    expect(trackAt(track, 60).legs[1]).toHaveLength(2);
  });

  it('finds the midpoint of a leg by distance', () => {
    const [lng, lat] = pointAlong(routeTrack(result).legs[0], 0.5)!;
    expect(lng).toBeCloseTo(106.81, 6);
    expect(lat).toBeCloseTo(-6.2, 6);
  });
});

describe('legLabelText', () => {
  const leg = { index: 1, lengthKm: 12.5, timeSeconds: 900, speedKmh: 50 };
  const arrival = { index: 2, offsetSeconds: 900, local: '2026-09-29T07:15', clock: '07:15' };

  it('shows speed, ETA or both', () => {
    expect(legLabelText(leg, arrival, 'speed')).toBe('L2 · 50 km/j');
    expect(legLabelText(leg, arrival, 'eta')).toBe('L2 · 15 mnt · tiba 07:15');
    expect(legLabelText(leg, undefined, 'all')).toBe('L2 · 12,5 km · 15 mnt · 50 km/j');
  });

  it('cycles the leg palette', () => {
    expect(legColor(0)).not.toBe(legColor(1));
    expect(legColor(8)).toBe(legColor(0));
  });
});
