import { RoutingError, createRouter, type Diagnostics, type ProgressEvent as SdkProgress, type RouteRequest, type RouteResult, type Router, type StartupResult, type WasmMemoryOptions } from 'valhalla-browser';
// The SDK ships a matching module worker and WASM binary next to its own entry point. Asking Vite
// for their URLs makes the application build emit both files, so the deployed SPA loads a worker
// from its own origin instead of resolving `new URL(..., import.meta.url)` inside a dependency.
import sdkWasmUrl from 'valhalla-browser/valhalla-browser.wasm?url';
import sdkWorkerUrl from 'valhalla-browser/worker.js?url';

/**
 * Default retained decoded-tile cache budget, in MiB.
 *
 * The two largest Jakarta level-2 tiles in the Indonesia release measure 48,442,160 B (46.2 MiB)
 * and 37,395,280 B (35.7 MiB), so the SDK default of 32 MiB refuses to initialize against this
 * dataset at all (`INVALID_REQUEST: Memory budget must fit the largest individual tile in this
 * dataset.`). Sizing the cache for roughly two large tiles made Valhalla evict and re-read them on
 * dense Java routes: a 24.5 km Jakarta route reported 3,459,976,392 B of graph bytes for four
 * distinct tiles, fetching them 146 times.
 */
const DEFAULT_MEMORY_BUDGET_MIB = 384;
/** The vendored engine's ceiling (`packages/valhalla-core/src/engine.ts`). */
const MAXIMUM_MEMORY_BUDGET_MIB = 512;

/**
 * Resolve the decoded-tile cache budget from a raw `VITE_MEMORY_BUDGET_MIB` build value.
 * @param raw - The environment value, or undefined when the build did not set one.
 * @returns Whole bytes for `memoryBudgetBytes`.
 * @remarks An unusable value falls back to the default with a warning rather than failing the
 * application; the effective budget is always visible in `startup.memoryBudgetBytes`.
 */
export function memoryBudgetBytes(raw: unknown = undefined): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_MEMORY_BUDGET_MIB * 1048576;
  const mib = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(mib) || mib < 1 || mib > MAXIMUM_MEMORY_BUDGET_MIB) {
    console.warn(`VITE_MEMORY_BUDGET_MIB=${String(raw)} is not an integer 1–${MAXIMUM_MEMORY_BUDGET_MIB} MiB; using ${DEFAULT_MEMORY_BUDGET_MIB} MiB.`);
    return DEFAULT_MEMORY_BUDGET_MIB * 1048576;
  }
  return mib * 1048576;
}

/**
 * Retained decoded-tile cache budget, overridable at build time so a measurement can compare
 * budgets without editing code: `VITE_MEMORY_BUDGET_MIB=96 pnpm build`.
 */
export const MEMORY_BUDGET_BYTES = memoryBudgetBytes(import.meta.env.VITE_MEMORY_BUDGET_MIB);
/**
 * Per-instance WASM linear memory, in MiB: the browser adapter's 128 MiB initial allocation with
 * its growth ceiling raised from 512 MiB to the SDK's maximum of 1024 MiB.
 *
 * The decoded-tile cache lives inside this heap, so a 384 MiB budget leaves a 512 MiB ceiling too
 * little room once a search's own label vectors grow. Measured against the deployed build, a
 * Jakarta → Bandung `bicycle` route (165.5 km, 48 tiles, 413,159,328 B) failed after 44.9 s with
 * `RESOURCE_LIMIT: Native routing exhausted its WASM memory budget.` at the 512 MiB default and
 * completes in 65.5 s at 1024 MiB with a 716,242,944 B (683 MiB) heap high-water; the same request
 * driven through the Node adapter's 256/512 MiB default fails the same way. The shorter routes
 * never approach it — the 24.5 km Jakarta pair peaks at 161,087,488 B (153.6 MiB) and
 * Jakarta → Bandung `motorcycle` at 231,997,440 B (221.3 MiB) — so the raised ceiling costs them
 * nothing: linear memory grows on demand and only the maximum changes.
 */
export const WASM_MEMORY: WasmMemoryOptions = { initialMiB: 128, maximumMiB: 1024 };
/**
 * Per-request fetch deadline. The loader default is 10 s and a 48 MB Jakarta tile was measured at
 * 79–101 s on a congested link. 60 s is the SDK's documented maximum for `timeoutMs`; the loader
 * and engine both reject anything above it with `INVALID_REQUEST: Invalid fetch limits.`
 */
export const REQUEST_TIMEOUT_MS = 60000;
/**
 * Route-stopping deadline, enforced on the host because the browser `Router` has no per-operation
 * deadline of its own. `valhalla-server`'s `routeTimeoutMs` is not part of `RouterOptions` here,
 * and the shared `deadline()` helper caps that option at 300 s.
 */
export const ROUTE_TIMEOUT_MS = 600000;

/** One cumulative measurement sample: the session's startup record and its live counters. */
export interface RouteDiagnosticsSample {
  /** Session startup measurements, or null before the first successful initialization. */
  startup: StartupResult | null;
  /** Cumulative loader, tile-trace and native memory/cache counters for the live worker. */
  diagnostics: Diagnostics;
}

declare global {
  interface Window {
    /**
     * Read-only measurement hook, installed when the client is created.
     *
     * It exposes exactly what `Router.diagnostics()` already returns (loader counters, tile traces
     * and native cache/heap counters) so `e2e/cache-budget.spec.ts` can record the decoded-tile
     * cache's behaviour against a deployed build. It adds no operation the UI does not have and
     * changes nothing about how a route is calculated.
     */
    valhallaDiagnostics?: () => Promise<RouteDiagnosticsSample>;
  }
}

export interface RouteClientOptions {
  /** Receives worker progress (runtime, graph, tiles, routing) for the progress indicator. */
  onProgress?: (event: SdkProgress) => void;
}

/** A route client: one lazily created SDK session plus the lifecycle the UI needs. */
export interface RouteClient {
  route(request: RouteRequest, signal?: AbortSignal): Promise<RouteResult>;
  cancel(): void;
  dispose(): Promise<void>;
  /** Cumulative loader/native counters for the live worker; queues behind an active route. */
  diagnostics(): Promise<RouteDiagnosticsSample>;
}

/**
 * Create the application's only SDK session.
 * @param manifestUrl - Versioned dataset manifest URL.
 * @param options - Progress callback for the UI.
 * @returns Route, cancel, dispose and diagnostics bound to one shared `Router`.
 * @remarks One client serves every route. Cancelling terminates the SDK worker and clears its tile
 * cache, so the next route re-downloads what it needs; that is the SDK's documented behaviour and
 * the price of a Cancel button that actually stops a 48 MB tile read.
 */
export function createRouteClient(manifestUrl: string, { onProgress }: RouteClientOptions = {}): RouteClient {
  let routerPromise: Promise<Router> | undefined;
  let active: AbortController | undefined;

  const router = (): Promise<Router> => (routerPromise ??= createRouter({
    manifestUrl,
    transport: 'indexed-tar',
    memoryBudgetBytes: MEMORY_BUDGET_BYTES,
    wasmMemory: WASM_MEMORY,
    timeoutMs: REQUEST_TIMEOUT_MS,
    onProgress,
    workerUrl: sdkWorkerUrl,
    wasmUrl: sdkWasmUrl,
  }).catch(error => {
    // A failed startup must stay retryable: the next run starts a fresh session rather than
    // replaying the same rejected promise.
    routerPromise = undefined;
    throw error;
  }));

  const diagnostics = async (): Promise<RouteDiagnosticsSample> => {
    const session = await router();
    return { startup: session.startup ?? null, diagnostics: await session.diagnostics() };
  };
  if (typeof window !== 'undefined') window.valhallaDiagnostics = diagnostics;

  return {
    async route(request, signal) {
      const controller = new AbortController();
      active = controller;
      let expired = false;
      const abort = () => controller.abort(new RoutingError('CANCELLED', 'Route cancelled.'));
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => {
        expired = true;
        controller.abort(new RoutingError('TIMEOUT', 'Routing operation deadline expired.'));
      }, ROUTE_TIMEOUT_MS);
      try {
        return await (await router()).route(request, { signal: controller.signal });
      } catch (error) {
        // The SDK reports an aborted operation as CANCELLED whichever way it was aborted, so the
        // host deadline is the only place that can tell a timeout from a user's Cancel.
        if (expired) throw new RoutingError('TIMEOUT', `Rute dihentikan setelah ${Math.round(ROUTE_TIMEOUT_MS / 60000)} menit tanpa hasil.`);
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (active === controller) active = undefined;
      }
    },
    cancel() {
      active?.abort(new RoutingError('CANCELLED', 'Route cancelled.'));
    },
    async dispose() {
      active?.abort(new RoutingError('DISPOSED', 'Router is disposed.'));
      if (!routerPromise) return;
      const pending = routerPromise;
      routerPromise = undefined;
      await (await pending.catch(() => undefined))?.dispose();
    },
    diagnostics,
  };
}
