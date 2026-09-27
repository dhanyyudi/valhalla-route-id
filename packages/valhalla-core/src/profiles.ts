import { RoutingError } from './errors.js';
import { BASE_COSTING_OPTIONS, COSTING_OPTIONS } from './types.js';
import type { Costing } from './types.js';
import type { NormalizedLocation, NormalizedRequest } from './protocol.js';

export const SUPPORTED_COSTINGS: readonly Costing[] = ['auto', 'motorcycle', 'motor_scooter', 'truck', 'bicycle', 'pedestrian'];

const PASSTHROUGH = new Set([
  'date_time', 'alternates', 'exclude_polygons', 'exclude_locations', 'avoid_edges', 'shape_format',
  'directions_options', 'linear_references', 'id', 'costing_options',
]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = (message: string): never => { throw new RoutingError('INVALID_REQUEST', message); };

export function validateRequest(request: unknown): NormalizedRequest {
  if (!object(request)) return invalid('A route request is required.');
  const costing = (request.costing === undefined ? 'auto' : request.costing) as Costing;
  if (!SUPPORTED_COSTINGS.includes(costing)) throw new RoutingError('UNSUPPORTED_COSTING', `Supported profiles: ${SUPPORTED_COSTINGS.join(', ')}.`);

  const raw = request.locations ?? [request.origin, request.destination];
  if (!Array.isArray(raw) || raw.length < 2) return invalid('At least two locations are required.');
  const locations = raw.map((point): NormalizedLocation => {
    if (!object(point) || typeof point.lat !== 'number' || !Number.isFinite(point.lat) || Math.abs(point.lat) > 90 ||
        typeof point.lon !== 'number' || !Number.isFinite(point.lon) || Math.abs(point.lon) > 180)
      return invalid('Coordinates must be finite latitude/longitude values.');
    return { ...point, lat: point.lat, lon: point.lon, radius: 30, minimum_reachability: 0 } as NormalizedLocation;
  });

  const allowed = new Set([...COSTING_OPTIONS[costing], ...BASE_COSTING_OPTIONS]);
  const mirrored: Record<string, Record<string, unknown>> = {};
  if (request.costing_options !== undefined) {
    if (!object(request.costing_options) || Object.keys(request.costing_options).length !== 1 || !Object.hasOwn(request.costing_options, costing))
      return invalid(`costing_options must contain only "${costing}".`);
    const options = request.costing_options[costing];
    if (!object(options)) return invalid('Profile options must be an object.');
    for (const [key, value] of Object.entries(options)) {
      if (!allowed.has(key)) return invalid(`Unsupported option: ${costing}.${key}.`);
      const type = typeof value;
      if (type !== 'number' && type !== 'boolean' && type !== 'string') return invalid(`${costing}.${key} must be a number, boolean or string.`);
      if (type === 'number' && !Number.isFinite(value as number)) return invalid(`${costing}.${key} must be finite.`);
    }
    mirrored[costing] = { ...options };
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
