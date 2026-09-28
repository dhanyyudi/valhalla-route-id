import { describe, expect, it } from 'vitest';
import { decodePolyline6, routeCoordinates } from './route-layer';
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
