import { beforeEach, describe, expect, it } from 'vitest';
import { SLOW_PROFILES, defaultDeparture, toRouteFailure, useScenario, withPresetHour } from './scenario';

const reset = () => useScenario.setState({
  waypoints: [], profile: 'auto', timeMode: 'now', options: {}, result: null, status: 'idle', error: null, progress: null,
});

describe('scenario store', () => {
  beforeEach(reset);

  it('adds, reverses and clears waypoints', () => {
    const store = useScenario.getState();
    store.addWaypoint({ lat: -6.1754, lng: 106.8272 });
    store.addWaypoint({ lat: -6.9175, lng: 107.6191 });
    useScenario.getState().reverseWaypoints();
    expect(useScenario.getState().waypoints.map(point => point.lat)).toEqual([-6.9175, -6.1754]);
    useScenario.getState().removeWaypoint(0);
    expect(useScenario.getState().waypoints).toEqual([{ lat: -6.1754, lng: 106.8272 }]);
    useScenario.getState().clearWaypoints();
    expect(useScenario.getState().waypoints).toEqual([]);
  });

  it('drops options the new profile cannot send', () => {
    useScenario.getState().setOption('use_tolls', 0);
    useScenario.getState().setOption('top_speed', 90);
    useScenario.getState().setProfile('motorcycle');
    expect(useScenario.getState().options).toEqual({ use_tolls: 0, top_speed: 90 });
    useScenario.getState().setProfile('pedestrian');
    expect(useScenario.getState().options).toEqual({});
    useScenario.getState().setProfile('truck');
    useScenario.getState().setOption('hazmat', true);
    useScenario.getState().setOption('width', 2.6);
    useScenario.getState().setProfile('auto');
    expect(useScenario.getState().options).toEqual({});
  });

  it('removes an option when it is set to undefined', () => {
    useScenario.getState().setOption('use_ferry', 1);
    useScenario.getState().setOption('use_ferry', undefined);
    expect(useScenario.getState().options).toEqual({});
  });

  it('refuses to route with fewer than two waypoints', async () => {
    useScenario.getState().addWaypoint({ lat: -6.1754, lng: 106.8272 });
    await useScenario.getState().run();
    expect(useScenario.getState().status).toBe('error');
    expect(useScenario.getState().error?.code).toBe('INVALID_REQUEST');
  });

  it('ignores cancel while idle', () => {
    useScenario.getState().cancel();
    expect(useScenario.getState().status).toBe('idle');
  });
});

describe('time helpers', () => {
  it('rounds the default departure up to the next whole hour', () => {
    expect(defaultDeparture(new Date(2026, 8, 28, 13, 41, 5))).toBe('2026-09-28T14:00');
    expect(defaultDeparture(new Date(2026, 8, 28, 23, 30, 0))).toBe('2026-09-29T00:00');
  });

  it('keeps the selected day when a preset hour is applied', () => {
    expect(withPresetHour('2026-09-28T13:41', 7)).toBe('2026-09-28T07:00');
    expect(withPresetHour('', 17)).toMatch(/T17:00$/);
  });
});

describe('toRouteFailure', () => {
  it('keeps the SDK code, message and native code verbatim', () => {
    const failure = toRouteFailure(Object.assign(new Error('Valhalla error 442.'), { code: 'NO_ROUTE', nativeCode: 442, retryable: false }));
    expect(failure).toEqual({ code: 'NO_ROUTE', message: 'Valhalla error 442.', nativeCode: 442, retryable: false });
  });

  it('falls back to RUNTIME for an untyped throw', () => {
    expect(toRouteFailure('boom')).toEqual({ code: 'RUNTIME', message: 'boom' });
  });
});

describe('slow profiles', () => {
  it('are exactly bicycle and pedestrian', () => {
    expect([...SLOW_PROFILES]).toEqual(['bicycle', 'pedestrian']);
  });
});
