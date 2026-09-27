import type { Coordinates, Costing } from './types.js';

export interface NormalizedLocation extends Coordinates {
  type?: 'break' | 'through' | 'break_through' | 'via';
  radius?: number;
  minimum_reachability?: number;
  preferred_side?: 'same' | 'opposite' | 'either';
  heading?: number;
  heading_tolerance?: number;
  name?: string;
  city?: string;
  date_time?: string;
  side_of_street?: string;
}
export interface NormalizedRequest {
  locations: NormalizedLocation[];
  costing: Costing;
  costing_options?: Record<string, Record<string, unknown>>;
  date_time?: { type: 1 | 2; value: string };
  alternates?: number;
  exclude_polygons?: string[];
  exclude_locations?: Coordinates[];
  avoid_edges?: number[];
  shape_format?: 'polyline6' | 'polyline5' | 'geojson' | 'no_shape';
  directions_options?: { language?: string; units?: string };
  units: 'kilometers';
  language: string;
  [key: string]: unknown;
}
