import { describe, expect, it } from 'vitest';
import {
  ACTIVE_WINDOWS,
  EXEMPT_PROFILES,
  JAKARTA_BBOX,
  activeWindowAt,
  evaluateGanjilGenap,
  isInJakartaRegion,
  wibParts,
  type PlateParity,
} from './ganjil-genap';

/**
 * A date `Date` for a WIB wall-clock time.
 *
 * WIB is UTC+7 and has no daylight saving, so `wib('2026-09-28 07:00')` is 2026-09-28T00:00:00Z.
 * Writing the fixtures this way keeps the assertions about *WIB* boundaries readable, and the fact
 * that the suite passes on a host in any timezone is the proof that the rule does its own offset
 * arithmetic instead of leaning on `Date`'s local getters.
 */
function wib(text: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(text);
  if (!match) throw new Error(`wib() needs "YYYY-MM-DD HH:MM", got ${text}`);
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour - 7, minute));
}

const evaluate = (text: string, plateParity: PlateParity, profile = 'auto', route?: Array<[number, number]>) =>
  evaluateGanjilGenap({ at: wib(text), profile, plateParity, route });

/** Monday 2026-09-28 is an even date (28); Tuesday 2026-09-29 is odd (29). */
const EVEN_MONDAY = '2026-09-28';
const ODD_TUESDAY = '2026-09-29';

describe('WIB arithmetic', () => {
  it('reads calendar fields in UTC+7, whatever the host timezone', () => {
    const parts = wibParts(new Date('2026-09-28T00:00:00Z'));
    expect(parts.isoDate).toBe('2026-09-28');
    expect(parts.dayOfWeek).toBe(1);
    expect(parts.hour).toBe(7);
    expect(parts.dateParity).toBe('even');
    // 23:00Z is already tomorrow in WIB — the case a naive `getHours()` gets wrong.
    const late = wibParts(new Date('2026-09-28T23:30:00Z'));
    expect(late.isoDate).toBe('2026-09-29');
    expect(late.hour).toBe(6);
    expect(late.minute).toBe(30);
    expect(late.dateParity).toBe('odd');
  });

  it('declares the two half-open windows the regulation uses', () => {
    expect(ACTIVE_WINDOWS.map(window => [window.startHour, window.endHour])).toEqual([[6, 10], [16, 21]]);
  });
});

describe('window boundaries', () => {
  const boundaries: Array<[string, boolean]> = [
    ['05:59', false],
    ['06:00', true],
    ['09:59', true],
    ['10:00', false],
    ['15:59', false],
    ['16:00', true],
    ['20:59', true],
    ['21:00', false],
  ];
  for (const [time, active] of boundaries) {
    it(`${time} WIB on a weekday is ${active ? 'inside' : 'outside'} an active window`, () => {
      const at = wib(`${EVEN_MONDAY} ${time}`);
      expect(activeWindowAt(at) !== null).toBe(active);
      // The status agrees with the window: active + matching parity is `allowed`, and a timeout is
      // never `restricted`.
      const even = evaluate(`${EVEN_MONDAY} ${time}`, 'even');
      expect(even.status).toBe(active ? 'allowed' : 'inactive_time');
      expect(even.window === null).toBe(!active);
      const odd = evaluate(`${EVEN_MONDAY} ${time}`, 'odd');
      expect(odd.status).toBe(active ? 'restricted' : 'inactive_time');
    });
  }

  it('names the window it found', () => {
    expect(activeWindowAt(wib(`${EVEN_MONDAY} 07:00`))?.label).toBe('Pagi');
    expect(activeWindowAt(wib(`${EVEN_MONDAY} 17:00`))?.label).toBe('Sore');
  });
});

describe('weekends', () => {
  it('is inactive all day on Saturday and Sunday', () => {
    // 2026-10-03 is a Saturday (odd date), 2026-10-04 a Sunday (even date).
    for (const day of ['2026-10-03', '2026-10-04']) {
      for (const time of ['00:00', '07:00', '12:00', '17:30', '23:59']) {
        const evaluation = evaluate(`${day} ${time}`, 'odd');
        expect(evaluation.status).toBe('inactive_time');
        expect(evaluation.window).toBeNull();
        expect(evaluation.reason).toContain('akhir pekan');
      }
    }
    expect(wibParts(wib('2026-10-03 12:00')).dayOfWeek).toBe(6);
    expect(wibParts(wib('2026-10-04 12:00')).dayOfWeek).toBe(0);
  });
});

describe('plate parity', () => {
  it('allows a plate whose parity matches the date', () => {
    const even = evaluate(`${EVEN_MONDAY} 07:00`, 'even');
    expect(even.status).toBe('allowed');
    expect(even.reason).toContain('boleh melintas');
    expect(evaluate(`${ODD_TUESDAY} 07:00`, 'odd').status).toBe('allowed');
  });

  it('restricts a plate whose parity differs from the date', () => {
    const odd = evaluate(`${EVEN_MONDAY} 07:00`, 'odd');
    expect(odd.status).toBe('restricted');
    expect(odd.reason).toContain('dilarang melintas');
    expect(odd.window?.label).toBe('Pagi');
    expect(evaluate(`${ODD_TUESDAY} 07:00`, 'even').status).toBe('restricted');
    // Both evening windows behave the same way.
    expect(evaluate(`${EVEN_MONDAY} 16:00`, 'odd').status).toBe('restricted');
    expect(evaluate(`${EVEN_MONDAY} 20:59`, 'odd').status).toBe('restricted');
  });

  it('treats "Nonaktif" as no constraint at all, even inside an active window', () => {
    const off = evaluate(`${EVEN_MONDAY} 07:00`, 'off');
    expect(off.status).toBe('inactive_time');
    expect(off.window).toBeNull();
    expect(off.reason).toContain('dimatikan');
  });

  it('carries the evaluated date and status for the panel', () => {
    const evaluation = evaluate(`${ODD_TUESDAY} 17:00`, 'odd');
    expect(evaluation.parts.isoDate).toBe(ODD_TUESDAY);
    expect(evaluation.parts.dateNumber).toBe(29);
    expect(evaluation.parts.hour).toBe(17);
    expect(evaluation.status).toBe('allowed');
  });
});

describe('exempt profiles', () => {
  for (const profile of EXEMPT_PROFILES) {
    it(`${profile} is exempt whatever the time and plate say`, () => {
      const restrictedTime = evaluate(`${EVEN_MONDAY} 07:00`, 'odd', profile);
      expect(restrictedTime.status).toBe('exempt_profile');
      expect(restrictedTime.window).toBeNull();
      expect(restrictedTime.reason).toContain('dibebaskan');
      // The toggle is not silently ignored: the reason says the exemption is why nothing is excluded.
      expect(restrictedTime.reason).toContain('tidak dikecualikan');
      // And it stays exempt outside the window too — same status, not a different one.
      expect(evaluate(`${EVEN_MONDAY} 12:00`, 'odd', profile).status).toBe('exempt_profile');
      expect(evaluate('2026-10-04 07:00', 'odd', profile).status).toBe('exempt_profile');
      expect(evaluate(`${EVEN_MONDAY} 07:00`, 'off', profile).status).toBe('exempt_profile');
    });
  }

  it('does not exempt cars or trucks', () => {
    expect(EXEMPT_PROFILES).toEqual(['motorcycle', 'motor_scooter']);
    expect(evaluate(`${EVEN_MONDAY} 07:00`, 'odd', 'auto').status).toBe('restricted');
    expect(evaluate(`${EVEN_MONDAY} 07:00`, 'odd', 'truck').status).toBe('restricted');
  });
});

describe('region', () => {
  it('uses the Jakarta/Jabodetabek box from the source implementation', () => {
    expect(JAKARTA_BBOX).toEqual({ minLng: 106.4, minLat: -6.75, maxLng: 107.2, maxLat: -5.8 });
    expect(isInJakartaRegion({ lng: 106.8272, lat: -6.1754 })).toBe(true);
    expect(isInJakartaRegion({ lng: 107.6191, lat: -6.9175 })).toBe(false);
  });

  it('is inactive when every point is outside Jakarta, even inside an active window', () => {
    const bandung: Array<[number, number]> = [[107.6191, -6.9175], [107.6, -6.9]];
    const evaluation = evaluate(`${EVEN_MONDAY} 07:00`, 'odd', 'auto', bandung);
    expect(evaluation.status).toBe('inactive_time');
    expect(evaluation.window).toBeNull();
    expect(evaluation.reason).toContain('luar area Jakarta');
  });

  it('stays restricted when only one end is outside Jakarta', () => {
    // A Jakarta → Bandung run still starts inside the box and must still avoid the corridors.
    const mixed: Array<[number, number]> = [[106.8272, -6.1754], [107.6191, -6.9175]];
    expect(evaluate(`${EVEN_MONDAY} 07:00`, 'odd', 'auto', mixed).status).toBe('restricted');
  });

  it('leaves the region out of it when no route is supplied', () => {
    expect(evaluate(`${EVEN_MONDAY} 07:00`, 'odd').status).toBe('restricted');
  });
});
