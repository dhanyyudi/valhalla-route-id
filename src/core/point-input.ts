/**
 * One-stop parsing for the paste box: a coordinate pair or a Google Maps link.
 *
 * Google Maps copies coordinates as `lat,lng` and every one of its URL forms carries the same
 * order, so latitude comes first unless the first number is too large to be one — which is the
 * only case that can be told apart without guessing. The parser never reorders a pair it cannot
 * disambiguate, because silently swapping a Jakarta-adjacent pair would move the waypoint by
 * hundreds of kilometres.
 */

export interface ParsedPoint { lat: number; lng: number }

export type PointParse = { ok: true; point: ParsedPoint } | { ok: false; message: string };

/** Google Maps viewport (`@lat,lng,zoom`) and marker (`!3dlat!4dlng`) coordinate pairs. */
const MARKER_PAIR = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/;
const VIEWPORT_PAIR = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/;
const QUERY_PAIR = /[?&](?:q|query|ll|center|daddr|destination|saddr|origin)=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i;
const PATH_PAIR = /\/(?:place|dir|search)\/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/;

const isGoogleMapsHost = (host: string): boolean => /(^|\.)(google\.[a-z.]+|goo\.gl)$/i.test(host);

function toPoint(first: number, second: number): PointParse {
  // Latitude first is the Google Maps order; a first value beyond ±90 can only be a longitude.
  const [lat, lng] = Math.abs(first) > 90 ? [second, first] : [first, second];
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return { ok: false, message: `Koordinat di luar rentang yang sah: ${first}, ${second}.` };
  }
  return { ok: true, point: { lat, lng } };
}

function fromUrl(input: string): PointParse | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, message: 'Tautan harus diawali http:// atau https://.' };
  if (!isGoogleMapsHost(url.hostname)) return { ok: false, message: `Tautan ${url.hostname} tidak dikenali; tempel koordinat atau tautan Google Maps.` };
  const haystack = `${url.pathname}${url.search}${url.hash}`;
  for (const pattern of [MARKER_PAIR, VIEWPORT_PAIR, QUERY_PAIR, PATH_PAIR]) {
    const match = pattern.exec(haystack);
    if (match) return toPoint(Number(match[1]), Number(match[2]));
  }
  // A shortened link has to be opened before it carries any coordinates; saying so beats
  // reporting a generic parse failure.
  return { ok: false, message: 'Tautan Google Maps pendek tidak memuat koordinat. Buka tautannya lebih dulu, lalu tempel koordinat atau tautan panjangnya.' };
}

/**
 * Parse the paste box's content.
 * @param input - A coordinate pair (`lat, lng`, `lng, lat` when unambiguous) or a Google Maps URL.
 * @returns The point, or a Bahasa Indonesia message explaining what was wrong with the input.
 */
export function parsePointInput(input: string): PointParse {
  const text = input.trim();
  if (!text) return { ok: false, message: 'Tempel koordinat (-6.1754, 106.8272) atau tautan Google Maps.' };
  if (/^https?:\/\//i.test(text)) return fromUrl(text) ?? { ok: false, message: 'Tautan tidak dapat dibaca.' };
  const numbers = text.match(/-?\d+(?:\.\d+)?/g);
  if (!numbers || numbers.length !== 2 || /[a-z]/i.test(text)) {
    return { ok: false, message: 'Format tidak dikenali. Contoh: -6.1754, 106.8272' };
  }
  return toPoint(Number(numbers[0]), Number(numbers[1]));
}
