import { describe, expect, it } from 'vitest';
import { decodeScenario, encodeScenario, type SharedScenario } from './share-url';

const scenario: SharedScenario = {
  waypoints: [{ lat: -6.1754, lng: 106.8272 }, { lat: -6.9175, lng: 107.6191 }],
  profile: 'motorcycle',
  timeMode: 'depart',
  departure: '2026-09-29T07:00',
  plateParity: 'odd',
  options: { use_tolls: 0, top_speed: 80, hazmat: true },
};

describe('share URL', () => {
  it('round-trips a full scenario', () => {
    const encoded = encodeScenario(scenario);
    expect(encoded).toBe('wp=-6.17540,106.82720;-6.91750,107.61910&profile=motorcycle&time=depart&at=2026-09-29T07%3A00&plate=odd&opt=use_tolls:0,top_speed:80,hazmat:true');
    expect(decodeScenario(`?${encoded}`)).toEqual(scenario);
  });

  it('omits defaults so a plain scenario stays short', () => {
    expect(encodeScenario({ ...scenario, profile: 'auto', timeMode: 'now', plateParity: 'off', options: {}, waypoints: [] })).toBe('');
    expect(decodeScenario('')).toEqual({});
  });

  it('drops what it cannot read instead of guessing', () => {
    expect(decodeScenario('wp=-6.1,106.8;abc;95,10;-6.2,106.9&profile=rocket&time=depart&at=tomorrow&plate=maybe&opt=Bad-Key:1,use_ferry:,top_speed:x,use_tolls:1')).toEqual({
      waypoints: [{ lat: -6.1, lng: 106.8 }, { lat: -6.2, lng: 106.9 }],
      options: { use_tolls: 1 },
    });
  });

  it('caps the stop count at the store limit', () => {
    const wp = Array.from({ length: 30 }, (_, index) => `-6.${index},106.8`).join(';');
    expect(decodeScenario(`wp=${wp}`).waypoints).toHaveLength(25);
  });
});
