// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SUPPORTED_COSTINGS, validateRequest } from '../src/profiles.js';

const at = (lat: number, lon: number) => ({ lat, lon });

describe('validateRequest', () => {
  it('accepts the six supported costings', () => {
    expect([...SUPPORTED_COSTINGS]).toEqual(['auto', 'motorcycle', 'motor_scooter', 'truck', 'bicycle', 'pedestrian']);
    for (const costing of SUPPORTED_COSTINGS) {
      expect(validateRequest({ locations: [at(-6.2, 106.8), at(-6.9, 107.6)], costing }).costing).toBe(costing);
    }
  });

  it('accepts more than two locations and normalizes each', () => {
    const result = validateRequest({ locations: [at(-6.2, 106.8), at(-6.5, 107.0), at(-6.9, 107.6)], costing: 'auto' });
    expect(result.locations).toHaveLength(3);
    // Correlation defaults belong to native: the validator must not invent `radius` or
    // `minimum_reachability`, because forcing them changes a caller's answer (the
    // correlation-default fix recorded in the verification report).
    for (const location of result.locations) {
      expect(location).not.toHaveProperty('radius');
      expect(location).not.toHaveProperty('minimum_reachability');
      expect(location).toMatchObject({ lat: expect.any(Number), lon: expect.any(Number) });
    }
  });

  it('passes caller-supplied correlation fields through untouched', () => {
    const result = validateRequest({
      locations: [{ lat: -6.2, lon: 106.8, radius: 500, minimum_reachability: 50 }, at(-6.9, 107.6)],
      costing: 'auto',
    });
    expect(result.locations[0]).toMatchObject({ radius: 500, minimum_reachability: 50 });
    expect(result.locations[1]).not.toHaveProperty('minimum_reachability');
  });

  it('rejects a correlation field that is not a finite non-negative number', () => {
    const withField = (field: string, value: unknown) => () => validateRequest({ locations: [{ lat: -6.2, lon: 106.8, [field]: value }, at(-6.9, 107.6)] });
    expect(withField('radius', -1)).toThrowError(/radius must be a finite non-negative number/);
    expect(withField('radius', '30')).toThrowError(/radius must be a finite non-negative number/);
    expect(withField('minimum_reachability', Number.NaN)).toThrowError(/minimum_reachability must be a finite non-negative number/);
    expect(withField('minimum_reachability', Number.POSITIVE_INFINITY)).toThrowError(/minimum_reachability must be a finite non-negative number/);
    // Zero is a legitimate caller choice, not an error: the validator passes it through.
    expect(validateRequest({ locations: [{ lat: -6.2, lon: 106.8, minimum_reachability: 0 }, at(-6.9, 107.6)] }).locations[0])
      .toMatchObject({ minimum_reachability: 0 });
  });

  it('preserves driver costing options that upstream used to reject', () => {
    const result = validateRequest({
      locations: [at(-6.2, 106.8), at(-6.9, 107.6)],
      costing: 'auto',
      costing_options: { auto: { use_highways: 0, use_tolls: 0, top_speed: 60 } },
    });
    expect(result.costing_options).toEqual({ auto: { use_highways: 0, use_tolls: 0, top_speed: 60 } });
  });

  it('preserves date_time, alternates, shape_format and directions_options', () => {
    const result = validateRequest({
      locations: [at(-6.2, 106.8), at(-6.9, 107.6)],
      costing: 'motorcycle',
      date_time: { type: 1, value: '2026-09-28T07:00' },
      alternates: 2,
      shape_format: 'geojson',
      directions_options: { language: 'id-ID' },
      exclude_polygons: ['-6.3,106.7,-6.25,106.75'],
    });
    expect(result.date_time).toEqual({ type: 1, value: '2026-09-28T07:00' });
    expect(result.alternates).toBe(2);
    expect(result.shape_format).toBe('geojson');
    expect(result.directions_options).toEqual({ language: 'id-ID' });
    expect(result.exclude_polygons).toEqual(['-6.3,106.7,-6.25,106.75']);
    expect(result.language).toBe('id-ID');
  });

  it('rejects unknown costing options for a profile', () => {
    expect(() => validateRequest({
      locations: [at(-6.2, 106.8), at(-6.9, 107.6)],
      costing: 'motor_scooter',
      costing_options: { motor_scooter: { use_highways: 0 } },
    })).toThrowError(/Unsupported option/);
  });

  it('rejects fewer than two locations and non-finite coordinates', () => {
    expect(() => validateRequest({ locations: [at(-6.2, 106.8)] })).toThrowError(/At least 2 location\(s\)/);
    expect(() => validateRequest({ locations: [at(Number.NaN, 106.8), at(-6.9, 107.6)] })).toThrowError(/finite/);
  });

  it('honours a raised or lowered minimum location count', () => {
    expect(() => validateRequest({ locations: [at(-6.2, 106.8)] }, { minimumLocations: 3 }))
      .toThrowError(/At least 3 location\(s\)/);
    expect(validateRequest({ locations: [at(-6.2, 106.8)] }, { minimumLocations: 1 }).locations).toHaveLength(1);
    expect(() => validateRequest({ locations: [] }, { minimumLocations: 1 })).toThrowError(/At least 1 location\(s\)/);
  });

  it('validates matrix sources and targets as the request locations', () => {
    const result = validateRequest({
      sources: [at(-6.2, 106.8), { ...at(-6.3, 106.9), id: 'depot' }],
      targets: [at(-6.9, 107.6)],
      costing: 'auto',
    }, { minimumLocations: 1 });
    expect(result.locations).toHaveLength(3);
    expect(result.locations.every(location => !('radius' in location) && !('minimum_reachability' in location))).toBe(true);
    expect(result.sources).toHaveLength(2);
    expect(result.targets).toHaveLength(1);
    // Documented matrix fields are preserved without unknown-field warnings.
    expect(result.__warnings).toBeUndefined();
    expect(() => validateRequest({ sources: [at(-6.2, 106.8)], costing: 'auto' }, { minimumLocations: 1 }))
      .toThrowError(/At least 1 location\(s\)/);
  });

  it('records unknown top-level fields as warnings instead of dropping them', () => {
    const result = validateRequest({ locations: [at(-6.2, 106.8), at(-6.9, 107.6)], invented_option: true });
    expect(result.invented_option).toBe(true);
    expect(result.__warnings).toEqual(['invented_option']);
  });
});
