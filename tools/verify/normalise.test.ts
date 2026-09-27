// @vitest-environment node
//
// Focused unit coverage for the Task 8 comparison rule. The 3.8 GB Indonesia graph is not
// needed here: these tests pin the properties that decide every verdict — error normalisation,
// sidecar alignment, corpus shape and exact (non-tolerant) equality of the returned JSON.
import { describe, expect, it } from 'vitest';
import { RoutingError } from 'valhalla-server/node';
import { assertAligned, buildCorpus, sdkNormalised } from './corpus.mjs';
import { canonicalJson, differenceContext, firstDifference, normaliseRoutingError, summarise } from './normalise.mjs';

const trip = (overrides = {}) => ({
  trip: {
    locations: [{ type: 'break', lat: -6.1754, lon: 106.8272, original_index: 0 }, { type: 'break', lat: -6.9175, lon: 107.6191, original_index: 1 }],
    legs: [{ maneuvers: [{ type: 2, instruction: 'Drive south.', time: 9.604, length: 0.053, cost: 11.765 }], summary: { time: 809.691, length: 11.327, cost: 2047.033 }, shape: 'vi|wJwjkwjE|\\O@eJiEDwB' }],
    summary: { time: 809.691, length: 11.327, cost: 2047.033 },
    status_message: 'Found route between points',
    status: 0,
    units: 'kilometers',
    language: 'en-US',
  },
  ...overrides,
});

describe('normaliseRoutingError', () => {
  it('serialises an SDK error carrying a native code as the native envelope', () => {
    const error = new RoutingError('NO_ROUTE', 'Valhalla error 442.', { nativeCode: 442 });
    expect(normaliseRoutingError(error)).toEqual({ nativeError: 442 });
    // The whole point: both engines agreeing there is no route must compare EQUAL.
    expect(canonicalJson(normaliseRoutingError(error))).toBe('{"nativeError":442}');
  });

  it('keeps native codes other than NO_ROUTE and LOCATION_NOT_FOUND', () => {
    expect(normaliseRoutingError(new RoutingError('LOCATION_NOT_FOUND', 'Valhalla error 171.', { nativeCode: 171 }))).toEqual({ nativeError: 171 });
    expect(normaliseRoutingError(new RoutingError('NATIVE', 'Valhalla error 110.', { nativeCode: 110 }))).toEqual({ nativeError: 110 });
  });

  it('reports an SDK-level gate as a distinct kind of failure, never as agreement', () => {
    const gated = normaliseRoutingError(new RoutingError('OUTSIDE_COVERAGE', 'A location is outside this dataset’s coverage.'));
    expect(gated).toEqual({ sdkError: { code: 'OUTSIDE_COVERAGE', message: 'A location is outside this dataset’s coverage.' } });
    expect(gated).not.toEqual({ nativeError: 442 });
    expect(canonicalJson(gated)).not.toBe('{"nativeError":442}');
  });

  it('tolerates a non-integer or missing nativeCode and still names the SDK category', () => {
    expect(normaliseRoutingError({ code: 'TIMEOUT', message: 'slow', nativeCode: undefined })).toEqual({ sdkError: { code: 'TIMEOUT', message: 'slow' } });
    expect(normaliseRoutingError({ code: 'TIMEOUT', message: 'slow', nativeCode: 1.5 })).toEqual({ sdkError: { code: 'TIMEOUT', message: 'slow' } });
    expect(normaliseRoutingError(new Error('boom'))).toEqual({ sdkError: { code: 'UNKNOWN', message: 'boom' } });
    expect(normaliseRoutingError(undefined)).toEqual({ sdkError: { code: 'UNKNOWN', message: 'undefined' } });
  });
});

describe('exact comparison', () => {
  it('accepts a round trip of the same route text', () => {
    const line = JSON.stringify(trip());
    expect(canonicalJson(JSON.parse(line))).toBe(line);
  });

  it('catches a silently different route that no summary change would reveal', () => {
    // One character of the encoded shape and one bearing differ; length, time and cost are equal.
    const mutated = trip();
    mutated.trip.legs[0].shape = 'vi|wJwjkwjE|\\O@eJiEDwC';
    const left = canonicalJson(trip());
    const right = canonicalJson(mutated);
    expect(left).not.toBe(right);
    expect(firstDifference(left, right)).toBeGreaterThan(0);
    expect(differenceContext(left, firstDifference(left, right), 8)).toContain('DwB');
  });

  it('catches a differing cost, a missing key and a reordered object', () => {
    const base = canonicalJson(trip());
    const cost = trip();
    cost.trip.summary.cost = 2047.034;
    expect(canonicalJson(cost)).not.toBe(base);
    const missing = trip();
    delete missing.trip.language;
    expect(canonicalJson(missing)).not.toBe(base);
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"b":1,"a":2}');
    expect(canonicalJson({ b: 1, a: 2 })).not.toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('compares identical doubles equal and differing doubles different, with no tolerance', () => {
    // The only spelling difference the runner tolerates: an integral double printed as `0.0`.
    expect(canonicalJson(JSON.parse('{"time":0.0,"length":0.0}'))).toBe('{"time":0,"length":0}');
    expect(canonicalJson(JSON.parse('{"time":11.327}'))).toBe(canonicalJson(JSON.parse('{"time":11.327}')));
    expect(canonicalJson(JSON.parse('{"time":11.327}'))).not.toBe(canonicalJson(JSON.parse('{"time":11.327000001}')));
  });

  it('reports the first differing offset and the end of a shared prefix', () => {
    expect(firstDifference('abc', 'abc')).toBe(-1);
    expect(firstDifference('abc', 'abd')).toBe(2);
    expect(firstDifference('abc', 'abcd')).toBe(3);
    expect(firstDifference('', 'x')).toBe(0);
    expect(differenceContext('0123456789', 5, 2)).toBe('…3456…');
  });
});

describe('sidecar alignment', () => {
  it('accepts a sidecar whose length matches the corpus', () => {
    expect(assertAligned(['{"locations":[]}', '{}'], ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('fails loudly when the sidecar and the corpus disagree', () => {
    expect(() => assertAligned(['{}', '{}'], ['a'])).toThrow(/Sidecar misalignment/);
    expect(() => assertAligned(['{}'], { names: ['a'] })).toThrow(/JSON array/);
    expect(() => assertAligned(['{}'], [''])).toThrow(/non-empty strings/);
  });
});

describe('corpus', () => {
  it('is pure Valhalla requests with no reporting field, aligned with its names', () => {
    const { lines, names } = buildCorpus();
    expect(lines.length).toBeGreaterThan(0);
    expect(names).toHaveLength(lines.length);
    expect(new Set(names).size).toBe(names.length);
    for (const line of lines) {
      const request = JSON.parse(line);
      expect(request).not.toHaveProperty('name');
      expect(Array.isArray(request.locations)).toBe(true);
      expect(request.locations.length).toBeGreaterThanOrEqual(2);
      // The shared language pin: without it the SDK host answers in Indonesian while native
      // answers in English (see the corpus module header).
      expect(request.directions_options.language).toBe('en-US');
    }
  });

  it('refuses a payload that carries a reporting field', () => {
    const payload = { locations: [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }], note: 'why' };
    expect(() => buildCorpus([{ name: 'bad', payload }])).toThrow(/pure Valhalla requests/);
  });

  it('mirrors the SDK host request normalisation', () => {
    const normalised = sdkNormalised({ locations: [{ lat: -6.1754, lon: 106.8272, preferred_side: 'opposite' }], costing: 'truck' });
    expect(normalised.locations[0]).toEqual({ lat: -6.1754, lon: 106.8272, preferred_side: 'opposite', radius: 30, minimum_reachability: 0 });
    expect(normalised.costing).toBe('truck');
    expect(normalised.units).toBe('kilometers');
    expect(normalised.language).toBe('id-ID');
    expect(sdkNormalised({ locations: [], directions_options: { language: 'en-US' } }).language).toBe('en-US');
    // The default costing the SDK applies is mirrored too.
    expect(sdkNormalised({ locations: [] }).costing).toBe('auto');
  });
});

describe('summarise', () => {
  it('describes a successful trip, a native error and an SDK gate distinctly', () => {
    expect(summarise(trip())).toBe('status 0: 11.327 km, 809.691 s, cost 2047.033, 1 maneuvers, polyline shape 22 chars');
    expect(summarise({ nativeError: 442 })).toBe('nativeError 442');
    expect(summarise({ sdkError: { code: 'OUTSIDE_COVERAGE', message: 'x' } })).toBe('sdkError OUTSIDE_COVERAGE');
    expect(summarise(null)).toBe('no output');
  });
});
