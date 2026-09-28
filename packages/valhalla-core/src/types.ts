/** Latitude/longitude in decimal degrees (WGS84). */
export interface Coordinates {
  /** Latitude in the inclusive range -90 to 90. */
  lat: number;
  /** Longitude in the inclusive range -180 to 180. */
  lon: number;
}
/** Validated road travel profiles. Transit and combined journeys are not supported. */
export type Costing = 'auto' | 'motorcycle' | 'motor_scooter' | 'truck' | 'bicycle' | 'pedestrian';

/** Per-profile option allowlists, copied from the pinned Valhalla sources (src/sif/*.cc). */
export const COSTING_OPTIONS: Record<Costing, readonly string[]> = {
  auto: ['use_highways', 'use_tolls', 'use_distance', 'top_speed', 'alley_factor', 'restriction_probability'],
  motorcycle: ['use_highways', 'use_tolls', 'use_trails', 'top_speed'],
  motor_scooter: ['use_primary', 'use_hills', 'top_speed'],
  truck: ['height', 'width', 'length', 'weight', 'axle_load', 'axle_count', 'hazmat', 'use_highways', 'use_tolls',
    'use_truck_route', 'low_class_penalty', 'low_class_factor', 'hgv_no_access_penalty', 'top_speed'],
  bicycle: ['bicycle_type', 'cycling_speed', 'use_roads', 'use_hills', 'avoid_bad_surfaces', 'bss_return_cost', 'bss_return_penalty'],
  pedestrian: ['walking_speed', 'use_hills', 'walkway_factor', 'sidewalk_factor', 'alley_factor', 'driveway_factor',
    'step_penalty', 'max_distance', 'max_grade', 'max_hiking_difficulty', 'mode_factor', 'type'],
};

/** Options accepted by every profile (valhalla/sif/dynamiccost.h base options). */
export const BASE_COSTING_OPTIONS: readonly string[] = [
  'use_ferry', 'use_rail_ferry', 'ferry_cost', 'rail_ferry_cost', 'service_penalty', 'service_factor', 'use_tracks',
  'use_living_streets', 'use_lit', 'closure_factor', 'speed_penalty_factor', 'maneuver_penalty', 'gate_cost',
  'gate_penalty', 'private_access_penalty', 'toll_booth_cost', 'toll_booth_penalty', 'country_crossing_cost',
  'country_crossing_penalty', 'alley_penalty', 'dest_only_penalty', 'shortest',
];
/** Driving settings; omitted values use the pinned Valhalla defaults. */
export interface AutoCostingOptions {
  /** Highway preference, 0–1; 0 avoids highways, 1 prefers them. */
  use_highways?: number;
  /** Toll road preference, 0–1; 0 avoids tolls, 1 prefers them. */
  use_tolls?: number;
  /** Distance preference, 0–1; 0 favours the fastest route, 1 the shortest. */
  use_distance?: number;
  /** Maximum speed in km/h. */
  top_speed?: number;
  /** Multiplier applied to the cost of traversing alleys, 0–1. */
  alley_factor?: number;
  /** Probability, 0–1, that a restricted turn or edge may be traversed. */
  restriction_probability?: number;
}
/** Bicycle settings; omitted values use the pinned Valhalla defaults. */
export interface BicycleCostingOptions {
  /** Bicycle type; defaults to hybrid. Type also determines the default cycling speed. */
  bicycle_type?: 'road' | 'cross' | 'hybrid' | 'mountain';
  /** Speed on smooth flat roads in km/h, 5–60. Defaults: road 25, cross 20, hybrid 18, mountain 16. */
  cycling_speed?: number;
  /** Road preference, 0–1; 0 prefers avoiding roads, 1 prefers roads. Default 0.25. */
  use_roads?: number;
}
/** Walking settings for the native foot profile. */
export interface PedestrianCostingOptions {
  /** Walking speed in km/h, 0.5–25; default 5.1. */
  walking_speed?: number;
}
/** Motorcycle settings; omitted values use the pinned Valhalla defaults. */
export interface MotorcycleCostingOptions {
  /** Highway preference, 0–1; 0 avoids highways, 1 prefers them. */
  use_highways?: number;
  /** Toll road preference, 0–1; 0 avoids tolls, 1 prefers them. */
  use_tolls?: number;
  /** Unpaved trail preference, 0–1; 0 avoids trails, 1 prefers them. */
  use_trails?: number;
  /** Maximum speed in km/h. */
  top_speed?: number;
}
/** Motor scooter settings; omitted values use the pinned Valhalla defaults. */
export interface MotorScooterCostingOptions {
  /** Primary road preference, 0–1; 0 avoids primary roads, 1 prefers them. */
  use_primary?: number;
  /** Hill preference, 0–1; 0 avoids hills, 1 prefers them. */
  use_hills?: number;
  /** Maximum speed in km/h. */
  top_speed?: number;
}
/** Truck attributes used with restrictions recorded in the graph. Omitted values use native defaults. */
export interface TruckCostingOptions {
  /** Height in meters, 0–10; default 4.11. */
  height?: number;
  /** Width in meters, 0–10; default 2.6. */
  width?: number;
  /** Length in meters, 0–50; default 21.64. */
  length?: number;
  /** Total vehicle weight in metric tonnes, 0–100; default 21.77. */
  weight?: number;
  /** Axle load in metric tonnes, 0–40; default 9.07. */
  axle_load?: number;
  /** Whether hazardous goods are carried; default false. */
  hazmat?: boolean;
}
/** Native option groups. A route accepts only the group matching its selected profile. */
export interface CostingOptions {
  /** Settings for cycling. */
  bicycle?: BicycleCostingOptions;
  /** Settings for walking. */
  pedestrian?: PedestrianCostingOptions;
  /** Vehicle attributes for truck routing. */
  truck?: TruckCostingOptions;
}
/**
 * Profile selection with its matching native option group.
 * @remarks Each arm accepts only the group matching its profile. A computed key such as
 * `{ [profile]: options }` is also accepted, because it cannot be checked statically; the
 * request validator rejects a missing, mismatched or multi-group `costing_options` at runtime.
 */
export type RouteProfile =
  | {
      /** Driving is the default when omitted. */
      costing?: 'auto';
      /** Only driving options are accepted. */
      costing_options?: {
        /** Driving settings for this route. */
        auto?: AutoCostingOptions;
        /** Motorcycle settings cannot be used for driving. */
        motorcycle?: never;
        /** Motor scooter settings cannot be used for driving. */
        motor_scooter?: never;
        /** Truck settings cannot be used for driving. */
        truck?: never;
        /** Bicycle settings cannot be used for driving. */
        bicycle?: never;
        /** Walking settings cannot be used for driving. */
        pedestrian?: never;
      };
    }
  | {
      /** Motorcycle profile. */
      costing: 'motorcycle';
      /** Only motorcycle options are accepted. */
      costing_options?: {
        /** Motorcycle settings for this route. */
        motorcycle?: MotorcycleCostingOptions;
        /** Driving settings cannot be used for motorcycling. */
        auto?: never;
        /** Motor scooter settings cannot be used for motorcycling. */
        motor_scooter?: never;
        /** Truck settings cannot be used for motorcycling. */
        truck?: never;
        /** Bicycle settings cannot be used for motorcycling. */
        bicycle?: never;
        /** Walking settings cannot be used for motorcycling. */
        pedestrian?: never;
      };
    }
  | {
      /** Motor scooter profile. */
      costing: 'motor_scooter';
      /** Only motor scooter options are accepted. */
      costing_options?: {
        /** Motor scooter settings for this route. */
        motor_scooter?: MotorScooterCostingOptions;
        /** Driving settings cannot be used for a motor scooter. */
        auto?: never;
        /** Motorcycle settings cannot be used for a motor scooter. */
        motorcycle?: never;
        /** Truck settings cannot be used for a motor scooter. */
        truck?: never;
        /** Bicycle settings cannot be used for a motor scooter. */
        bicycle?: never;
        /** Walking settings cannot be used for a motor scooter. */
        pedestrian?: never;
      };
    }
  | {
      /** Truck profile. */
      costing: 'truck';
      /** Only truck options are accepted. */
      costing_options?: {
        /** Vehicle attributes for this route. */
        truck?: TruckCostingOptions;
        /** Driving settings cannot be used for truck routing. */
        auto?: never;
        /** Motorcycle settings cannot be used for truck routing. */
        motorcycle?: never;
        /** Motor scooter settings cannot be used for truck routing. */
        motor_scooter?: never;
        /** Bicycle settings cannot be used for truck routing. */
        bicycle?: never;
        /** Walking settings cannot be used for truck routing. */
        pedestrian?: never;
      };
    }
  | {
      /** Cycling profile. */
      costing: 'bicycle';
      /** Only bicycle options are accepted. */
      costing_options?: {
        /** Bicycle settings for this route. */
        bicycle?: BicycleCostingOptions;
        /** Driving settings cannot be used for cycling. */
        auto?: never;
        /** Motorcycle settings cannot be used for cycling. */
        motorcycle?: never;
        /** Motor scooter settings cannot be used for cycling. */
        motor_scooter?: never;
        /** Truck settings cannot be used for cycling. */
        truck?: never;
        /** Walking settings cannot be used for cycling. */
        pedestrian?: never;
      };
    }
  | {
      /** Walking profile. */
      costing: 'pedestrian';
      /** Only pedestrian options are accepted. */
      costing_options?: {
        /** Walking settings for this route. */
        pedestrian?: PedestrianCostingOptions;
        /** Driving settings cannot be used for walking. */
        auto?: never;
        /** Motorcycle settings cannot be used for walking. */
        motorcycle?: never;
        /** Motor scooter settings cannot be used for walking. */
        motor_scooter?: never;
        /** Truck settings cannot be used for walking. */
        truck?: never;
        /** Bicycle settings cannot be used for walking. */
        bicycle?: never;
      };
    };
/** Request fields upstream did not expose; every one is optional. */
export interface ExtendedRouteFields {
  /** Profile options keyed by costing, for example `{ auto: { use_tolls: 0 } }`; the validator accepts only the group matching `costing`. */
  costing_options?: Record<string, Record<string, unknown>>;
  locations?: Array<Coordinates & {
    type?: 'break' | 'through' | 'break_through' | 'via';
    preferred_side?: 'same' | 'opposite' | 'either';
    heading?: number;
    heading_tolerance?: number;
    date_time?: string;
    name?: string;
    city?: string;
  }>;
  date_time?: { type: 1 | 2; value: string };
  alternates?: number;
  exclude_polygons?: string[];
  exclude_locations?: Coordinates[];
  avoid_edges?: number[];
  shape_format?: 'polyline6' | 'polyline5' | 'geojson' | 'no_shape';
  directions_options?: { language?: string; units?: string };
}
/**
 * N ordered locations (at least two) with a supported road profile and optional matching settings.
 * @remarks Supply origin/destination, an ordered locations array, or both; the validator requires
 * two or more finite locations. The SDK fixes kilometers and defaults instruction language to
 * Bahasa Indonesia (`directions_options.language` is `id-ID` unless overridden). Per-location
 * correlation fields (`radius`, `minimum_reachability`) are forwarded exactly as supplied and are
 * never forced, so native's own defaults apply unless the caller sets them. `date_time`,
 * `alternates`, `exclude_polygons` and `shape_format` are accepted.
 */
export type RouteRequest = RouteProfile & ExtendedRouteFields & {
  /** Start coordinate inside the dataset coverage. */
  origin?: Coordinates;
  /** End coordinate inside the dataset coverage. */
  destination?: Coordinates;
};
/**
 * One or more centers with the contour bands to compute around them.
 * @remarks Contours are reachability bands in minutes and/or kilometers from each center.
 * Native rejects a request with no contours. `polygons` selects filled polygons instead of
 * the default contour lines; `denoise` (0–1) removes small disconnected areas and
 * `generalize` (0–500 m) simplifies the geometry.
 */
export interface IsochroneRequest {
  /** Centers of the isochrones; the dataset limits isochrone requests to one location. */
  locations: Coordinates[];
  /** Profile that defines reachability. */
  costing: Costing;
  /** Contour bands, at least one, each with a `time` in minutes or a `distance` in kilometers and an optional hex `color`. */
  contours: Array<{ time?: number; distance?: number; color?: string }>;
  /** Return filled polygons instead of lines. */
  polygons?: boolean;
  /** Contour denoising factor, 0–1. */
  denoise?: number;
  /** Polygon generalization tolerance in meters, 0–500. */
  generalize?: number;
  /** Include the input centers in the response. */
  show_locations?: boolean;
  /** Profile options keyed by costing; the validator accepts only the group matching `costing`. */
  costing_options?: Record<string, Record<string, unknown>>;
  /** Departure or arrival time applied to the centers. */
  date_time?: { type: 1 | 2; value: string };
}
/**
 * Sources crossed with targets, with computed times and distances for every pair.
 * @remarks Every source is paired with every target, so the response is a
 * `sources.length` by `targets.length` matrix.
 */
export interface MatrixRequest {
  /** Origin locations, at least one. */
  sources: Array<Coordinates & { id?: number | string }>;
  /** Destination locations, at least one. */
  targets: Array<Coordinates & { id?: number | string }>;
  /** Profile used for every pair. */
  costing: Costing;
  /** Profile options keyed by costing; the validator accepts only the group matching `costing`. */
  costing_options?: Record<string, Record<string, unknown>>;
  /** Departure or arrival time applied to the appropriate matrix side. */
  date_time?: { type: 1 | 2; value: string };
}
/** Delivery method for the same standard Valhalla graph tiles. */
export type TileTransport = 'indexed-tar' | 'individual-tiles';
/** Current stage of worker initialization or routing. Events are informational, not a percentage. */
export type ProgressPhase = 'loading-runtime' | 'initializing-graph' | 'fetching-tile' | 'routing';
/** Progress notification from the active worker operation. */
export interface ProgressDetail {
  /** Current initialization, computation or download stage. */
  phase: ProgressPhase;
  /** Decimal GraphId when the event concerns a tile; absent for other events. */
  tileId?: string;
}
/** Host progress notification associated with a request ID. */
export interface ProgressEvent extends ProgressDetail {
  /** Monotonically increasing operation ID within this Router. */
  requestId: number;
}

/**
 * Native search-label allocation policy, applied when the actor initializes.
 * @remarks Reservations are label counts per vector, not bytes or search limits.
 * Searches can grow beyond them. These settings override the dataset's A* reservations.
 * They neither change costing nor impose a total-worker memory limit.
 */
export interface SearchMemoryOptions {
  /** Initial single-direction A* label reservation: integer 0–2,000,000, default 16,384. Zero grows storage on demand. Also sizes the Dijkstra reservations behind the isochrone tool. */
  astar?: number;
  /** Initial bidirectional A* label reservation in each direction: integer 0–2,000,000, default 16,384. Zero grows storage on demand. Also sizes the Dijkstra reservations behind the matrix and optimized-route tools. */
  bidirectionalAstar?: number;
  /** Ask native cleanup to release used search-label vectors after each route; default false retains reusable reservations. Does not shrink WASM linear memory or clear decoded tiles. */
  clearReservedMemory?: boolean;
}
/** Fully resolved search-label settings used by the initialized actor. */
export type EffectiveSearchMemory = Readonly<Required<SearchMemoryOptions>>;

/** Per-instance WebAssembly linear memory. MiB means 1,048,576 bytes. */
export interface WasmMemoryOptions {
  /** Initial allocation in whole MiB, at least 64 and no greater than maximumMiB. Defaults to 128 in browsers, 256 in Node, 64 in Cloudflare. Set explicitly when maximumMiB is below the host's default initial allocation. */
  initialMiB?: number;
  /** Hard growth ceiling in whole MiB, up to 1024. Default 512 in browser/Node, 96 in Cloudflare. Includes C++ heap, stack and static data; excludes JavaScript and total process/isolate memory. Fixed for the instance's lifetime. */
  maximumMiB?: number;
}
/** Actual initial allocation and hard growth ceiling selected at initialization. */
export type EffectiveWasmMemory = Readonly<Required<WasmMemoryOptions>>;

/**
 * Fetch attempts and validated bytes; these are not necessarily origin network transfers.
 * Route results contain per-route deltas; session diagnostics contain cumulative values.
 */
export interface LoaderMetrics {
  /** Tile-loader Fetch API attempts, including retries and archive index/header reads. Excludes manifest/config fetches. */
  requests: number;
  /** Successfully downloaded complete tiles; evicted tiles can be downloaded again. */
  tileDownloads: number;
  /** Validated response-body bytes consumed by the tile loader, including its metadata reads. */
  bytes: number;
  /** Portion of bytes used by the native archive header/index, excluding JSON metadata. */
  metadataBytes: number;
  /** Accumulated download time in ms, including body reads, retries/backoff and integrity validation. */
  sequentialWaitMs: number;
  /** Requests sharing an already in-flight download. */
  deduplicated: number;
  /** Additional fetch attempts after transient failures. */
  retries: number;
}
/** Native build identity and cumulative memory/cache counters for this worker. */
export interface NativeStats {
  /** Bytes retained in the native decoded-tile cache; excludes live references outside that cache. */
  decodedCacheBytes: number;
  /** Cumulative native tile-cache lookup hits. */
  decodedCacheHits: number;
  /** Allocated linear-memory capacity high-water in bytes, not live allocations or process RSS. */
  wasmHeapCapacityHighWaterBytes: number;
  /** Valhalla release compiled into the worker's WASM. */
  valhallaVersion: string;
  /** Upstream Git revision compiled into WASM; must match the dataset. */
  sourceRevision: string;
  /** SDK/native bridge ABI version. */
  abi: number;
}
/** Module and graph initialization measurements; times are milliseconds. */
export interface StartupResult {
  /** Profiles supported by both this SDK and the dataset manifest. Old auto-only datasets remain driving-only. */
  supportedCostings: readonly Costing[];
  /** Immutable dataset release ID. */
  release: string;
  /** SHA-256 of the validated runtime configuration bytes. */
  configSha256: string;
  /** SHA-256 of the JSON actually passed to native initialization, including transport URLs, tile-cache settings and search-memory overrides. */
  effectiveConfigSha256: string;
  /** WASM loading/compilation/instantiation time inside the worker. */
  moduleStartupMs: number;
  /** JSON metadata download/validation plus native graph-reader initialization time. */
  graphStartupMs: number;
  /** Main-thread elapsed time until the worker and graph are ready, including worker loading. */
  workerReadyMs: number;
  /** Fetch attempts during startup, including manifest/config and loader metadata attempts. */
  graphStartupRequests: number;
  /** Validated startup body bytes, including manifest/config and loader metadata. */
  graphStartupBytes: number;
  /** Effective retained decoded-tile cache budget in bytes. */
  memoryBudgetBytes: number;
  /** Resolved per-instance WASM linear-memory settings. */
  wasmMemory: EffectiveWasmMemory;
  /** Effective search-label reservations and cleanup policy for this actor. */
  searchMemory: EffectiveSearchMemory;
  /** Loader counters sampled at startup completion. */
  loader: LoaderMetrics;
  /** Native identity and memory counters sampled at startup completion. */
  native: NativeStats;
}
/** Full Valhalla JSON with typed common fields and preserved additional native fields. */
export interface NativeRoute {
  /** Successful native trip response, including its ordered legs. */
  trip: {
    /** Totals across the trip. */
    summary: {
      /** Total distance in kilometers. */
      length: number;
      /** Estimated travel time in seconds. */
      time: number;
      [key: string]: unknown;
    };
    /** Native route legs, in travel order. */
    legs: Array<{
      /** Encoded polyline using six decimal places (polyline6). */
      shape: string;
      /** Ordered turn instructions for this leg. */
      maneuvers: Array<{
        /** English maneuver instruction. */
        instruction: string;
        /** Native Valhalla maneuver type number. */
        type: number;
        /** Maneuver distance in kilometers. */
        length: number;
        /** Maneuver travel time in seconds. */
        time: number;
        [key: string]: unknown;
      }>;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
/** Native response, immutable dataset identity and per-route diagnostics. */
export interface RouteResult {
  /** Complete native response: kilometers, seconds, and polyline6 shapes. */
  native: NativeRoute;
  /** Identifies the graph and configuration used to calculate this response. */
  dataset: {
    /** Immutable release directory name. */
    release: string;
    /** Upstream Valhalla Git revision for these tiles. */
    valhallaRevision: string;
    /** SHA-256 of the dataset's runtime configuration. */
    configSha256: string;
    /** SHA-256 of the effective native initialization JSON, including SDK overrides. Matches StartupResult.effectiveConfigSha256. */
    effectiveConfigSha256: string;
  };
  /** Measurements for this operation; nested native counters remain cumulative. */
  diagnostics: {
    /** Worker-observed native route call time in ms, including Asyncify fetch waits. */
    routeMs: number;
    /** Main-thread route-call time in ms, including any lazy startup and queue wait. */
    hostRouteMs: number;
    /** Native decoded-cache hits during this route only. */
    decodedCacheHits: number;
    /** Loader counter deltas during this route. */
    loader: LoaderMetrics;
    /** Cumulative native state after the route. */
    native: NativeStats;
  };
}
/** A validated tile/metadata fetch; 64-bit offsets and lengths remain decimal strings. */
export interface TileTrace {
  /** Actual requested object URL; avoid logging traces by default. */
  url: string;
  /** Requested byte offset in the object, as an exact decimal string. */
  offset: string;
  /** Requested byte count, as an exact decimal string. */
  size: string;
  /** Decimal GraphId for tile reads, absent for archive metadata. */
  tileId?: string;
  /** Download elapsed time in ms, including retries/backoff and integrity validation. */
  elapsedMs: number;
  /** Selected response headers; inaccessible or missing values are null. Cache headers may be replayed from browser cache. */
  http: Record<string, string | null>;
}
/** Cumulative loader, cache and memory data for the current worker. */
export interface Diagnostics {
  /** Cumulative counters since this worker's loader was created. */
  metrics: LoaderMetrics;
  /** Most recent 2,048 successful validated fetch traces, including tile URLs and IDs. No telemetry is sent automatically. */
  trace: TileTrace[];
  /** Current native build identity and cumulative memory/cache counters. */
  native: NativeStats;
  /** Browser resource timings as exposed inside the worker. Cross-origin zeros without Timing-Allow-Origin do not prove cache hits. */
  resourceTiming: Array<{
    /** Requested resource URL. */
    name: string;
    /** Browser-observed resource duration in milliseconds. */
    durationMs: number;
    /** Browser transfer-size field in bytes, or null when unavailable. Zero can mean either caching or restricted visibility. */
    transferSize: number | null;
    /** Encoded response-body size in bytes, or null when unavailable. Cross-origin restrictions can produce zero. */
    encodedBodySize: number | null;
    /** Decoded response-body size in bytes, or null when unavailable. Cross-origin restrictions can produce zero. */
    decodedBodySize: number | null;
  }>;
}
