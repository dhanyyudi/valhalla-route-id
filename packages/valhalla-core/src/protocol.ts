import type { Coordinates, Costing, ExcludePolygons } from './types.js';

export interface NormalizedLocation extends Coordinates {
  type?: 'break' | 'through' | 'break_through' | 'via';
  /**
   * Correlation search radius in metres. Present only when the caller supplied it:
   * `validateRequest` never forces a value, so native Valhalla's own default applies otherwise.
   */
  radius?: number;
  /**
   * Minimum connectivity loki requires of the edge a location correlates to. Present only when the
   * caller supplied it; native's default for this project's pinned config is 50, and forcing 0
   * instead moved three of the sixteen verification-corpus answers.
   */
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
  exclude_polygons?: ExcludePolygons;
  exclude_locations?: Coordinates[];
  avoid_edges?: number[];
  shape_format?: 'polyline6' | 'polyline5' | 'geojson' | 'no_shape';
  directions_options?: { language?: string; units?: string };
  units: 'kilometers';
  language: string;
  [key: string]: unknown;
}
