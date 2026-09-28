import { describe, expect, it } from 'vitest';
import { parsePointInput } from './point-input';

describe('parsePointInput', () => {
  it('reads a plain latitude/longitude pair', () => {
    expect(parsePointInput('-6.1754, 106.8272')).toEqual({ ok: true, point: { lat: -6.1754, lng: 106.8272 } });
    expect(parsePointInput('  -6.1754  106.8272  ')).toEqual({ ok: true, point: { lat: -6.1754, lng: 106.8272 } });
    expect(parsePointInput('-6.9175;107.6191')).toEqual({ ok: true, point: { lat: -6.9175, lng: 107.6191 } });
  });

  it('reads a longitude-first pair when the first number cannot be a latitude', () => {
    expect(parsePointInput('106.8272, -6.1754')).toEqual({ ok: true, point: { lat: -6.1754, lng: 106.8272 } });
  });

  it('reads the coordinates out of a Google Maps place URL', () => {
    const link = 'https://www.google.com/maps/place/Monas/@-6.1753924,106.8271528,17z/data=!3m1!4b1';
    expect(parsePointInput(link)).toEqual({ ok: true, point: { lat: -6.1753924, lng: 106.8271528 } });
  });

  it('reads the coordinates out of a Google Maps query URL', () => {
    expect(parsePointInput('https://maps.google.com/?q=-6.9175,107.6191')).toEqual({ ok: true, point: { lat: -6.9175, lng: 107.6191 } });
    expect(parsePointInput('https://www.google.com/maps?ll=-6.2,106.8&z=12')).toEqual({ ok: true, point: { lat: -6.2, lng: 106.8 } });
  });

  it('prefers the marker coordinates of a Google Maps data parameter over the viewport', () => {
    const link = 'https://www.google.com/maps/place/Bandung/@-6.9,107.6,12z/data=!3d-6.9175!4d107.6191';
    expect(parsePointInput(link)).toEqual({ ok: true, point: { lat: -6.9175, lng: 107.6191 } });
  });

  it('explains that a shortened Google Maps link carries no coordinates', () => {
    const result = parsePointInput('https://maps.app.goo.gl/abcdEFGH1234');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/pendek/i);
  });

  it('rejects empty, unparseable and out-of-range input', () => {
    expect(parsePointInput('   ').ok).toBe(false);
    expect(parsePointInput('Jakarta').ok).toBe(false);
    expect(parsePointInput('91.0, 106.8').ok).toBe(false);
    expect(parsePointInput('-6.1754, 200.0').ok).toBe(false);
  });
});
