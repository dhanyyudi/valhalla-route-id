import { RoutingError } from './errors.js';
import { BASE_COSTING_OPTIONS, COSTING_OPTIONS } from './types.js';
import type { Costing } from './types.js';
import type { NormalizedLocation, NormalizedRequest } from './protocol.js';

export const SUPPORTED_COSTINGS: readonly Costing[] = ['auto', 'motorcycle', 'motor_scooter', 'truck', 'bicycle', 'pedestrian'];

const PASSTHROUGH = new Set([
  'date_time', 'alternates', 'exclude_polygons', 'exclude_locations', 'avoid_edges', 'shape_format',
  'directions_options', 'linear_references', 'id', 'costing_options',
  'sources', 'targets', 'contours', 'polygons', 'denoise', 'generalize', 'show_locations',
]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = (message: string): never => { throw new RoutingError('INVALID_REQUEST', message); };

/**
 * Per-location correlation fields this validator forwards verbatim.
 *
 * It never invents a value for either: `radius` and `minimum_reachability` are loki search
 * parameters with native defaults of their own, and substituting a value here silently changes a
 * caller's answer rather than validating it.
 */
const CORRELATION_FIELDS = ['radius', 'minimum_reachability'] as const;

/** Validation bounds that differ between a route and the single-center/one-sided tools. */
export interface ValidateRequestOptions {
  /** Smallest accepted number of locations; defaults to two, the native route minimum. */
  minimumLocations?: number;
}

/**
 * Validate a request and return the exact copy this runtime hands to the WASM engine.
 *
 * The copy differs from the caller's request only where the runtime has to resolve something the
 * engine cannot: `locations` becomes the validated coordinate list (a matrix `sources`/`targets`
 * pair folds into it), `costing` gets its documented default, `units` is pinned to kilometres and
 * `language` is resolved from `directions_options`.
 *
 * Per-location correlation fields (`radius`, `minimum_reachability`) are **forwarded exactly as
 * the caller sent them and never forced**. Native Valhalla applies its own defaults when they are
 * absent — this project's pinned native config sets `minimum_reachability: 50` — and those
 * defaults are what let loki correlate a destination to a usable edge. Forcing
 * `minimum_reachability: 0` instead allowed correlation to a low-reachability edge inside a small,
 * unconnected component, which flipped three of the sixteen native-versus-WASM corpus answers (one
 * route to `NO_ROUTE`/error 442, one to a different 97.186 km route; see the Task 8 verification
 * report and the review that produced this change). A caller that wants a value supplies it, and a
 * supplied value must be a finite number ≥ 0.
 */
export function validateRequest(request: unknown, options: ValidateRequestOptions = {}): NormalizedRequest {
  if (!object(request)) return invalid('A route request is required.');
  const costing = (request.costing === undefined ? 'auto' : request.costing) as Costing;
  if (!SUPPORTED_COSTINGS.includes(costing)) throw new RoutingError('UNSUPPORTED_COSTING', `Supported profiles: ${SUPPORTED_COSTINGS.join(', ')}.`);

  const minimumLocations = options.minimumLocations ?? 2;
  // A matrix request carries `sources` and `targets` instead of `locations`. Both sides are
  // required natively, and their combined size is the request's location count. The validated
  // copy of that count is exposed as `locations` so callers can run coverage checks on it;
  // native ignores it for matrix actions.
  const matrix = Array.isArray(request.sources) || Array.isArray(request.targets);
  const raw = matrix
    ? Array.isArray(request.sources) && Array.isArray(request.targets) ? [...request.sources, ...request.targets] : []
    : request.locations ?? [request.origin, request.destination];
  if (!Array.isArray(raw) || raw.length < minimumLocations) return invalid(`At least ${minimumLocations} location(s) are required.`);
  const locations = raw.map((point): NormalizedLocation => {
    if (!object(point) || typeof point.lat !== 'number' || !Number.isFinite(point.lat) || Math.abs(point.lat) > 90 ||
        typeof point.lon !== 'number' || !Number.isFinite(point.lon) || Math.abs(point.lon) > 180)
      return invalid('Coordinates must be finite latitude/longitude values.');
    // Correlation defaults belong to the engine, not to this validator: pass a supplied value
    // through untouched and leave the field out entirely when the caller did not send one.
    for (const field of CORRELATION_FIELDS) {
      const value = point[field];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return invalid(`${field} must be a finite non-negative number.`);
    }
    return { ...point, lat: point.lat, lon: point.lon } as NormalizedLocation;
  });

  const allowed = new Set([...COSTING_OPTIONS[costing], ...BASE_COSTING_OPTIONS]);
  const mirrored: Record<string, Record<string, unknown>> = {};
  if (request.costing_options !== undefined) {
    if (!object(request.costing_options) || Object.keys(request.costing_options).length !== 1 || !Object.hasOwn(request.costing_options, costing))
      return invalid(`costing_options must contain only "${costing}".`);
    const profileOptions = request.costing_options[costing];
    if (!object(profileOptions)) return invalid('Profile options must be an object.');
    for (const [key, value] of Object.entries(profileOptions)) {
      if (!allowed.has(key)) return invalid(`Unsupported option: ${costing}.${key}.`);
      const type = typeof value;
      if (type !== 'number' && type !== 'boolean' && type !== 'string') return invalid(`${costing}.${key} must be a number, boolean or string.`);
      if (type === 'number' && !Number.isFinite(value as number)) return invalid(`${costing}.${key} must be finite.`);
    }
    mirrored[costing] = { ...profileOptions };
  }

  const normalized: NormalizedRequest = {
    ...request,
    locations,
    costing,
    ...(request.costing_options === undefined ? {} : { costing_options: mirrored }),
    units: 'kilometers',
    language: object(request.directions_options) && typeof request.directions_options.language === 'string'
      ? request.directions_options.language
      : 'id-ID',
  };
  const warnings = Object.keys(request).filter(key => !PASSTHROUGH.has(key) && !['locations', 'origin', 'destination', 'costing', 'units', 'language'].includes(key));
  if (warnings.length) normalized.__warnings = warnings;
  return normalized;
}
