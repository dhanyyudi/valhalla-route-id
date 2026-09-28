import { describe, expect, it } from 'vitest';
import { buildRouteRequest, type Scenario } from './request-builder';

const base: Scenario = {
  waypoints: [{ lng: 106.8272, lat: -6.1754 }, { lng: 107.6191, lat: -6.9175 }],
  profile: 'motorcycle',
  timeMode: 'depart',
  departure: '2026-09-28T07:00',
  options: {},
};

describe('buildRouteRequest', () => {
  it('maps waypoints, profile and departure time', () => {
    expect(buildRouteRequest(base)).toEqual({
      locations: [{ lat: -6.1754, lon: 106.8272 }, { lat: -6.9175, lon: 107.6191 }],
      costing: 'motorcycle',
      date_time: { type: 1, value: '2026-09-28T07:00' },
      directions_options: { language: 'id-ID', units: 'kilometers' },
    });
  });

  it('switches to arrive_by and omits empty options', () => {
    const request = buildRouteRequest({ ...base, timeMode: 'arrive', options: { use_tolls: 0 } });
    expect(request.date_time).toEqual({ type: 2, value: '2026-09-28T07:00' });
    expect(request.costing_options).toEqual({ motorcycle: { use_tolls: 0 } });
  });

  it('omits date_time in now mode', () => {
    expect(buildRouteRequest({ ...base, timeMode: 'now' }).date_time).toBeUndefined();
  });
});
