import { RoutingError, createRouter, type ProgressEvent as SdkProgress, type RouteRequest, type RouteResult, type Router } from 'valhalla-browser';
// The SDK ships a matching module worker and WASM binary next to its own entry point. Asking Vite
// for their URLs makes the application build emit both files, so the deployed SPA loads a worker
// from its own origin instead of resolving `new URL(..., import.meta.url)` inside a dependency.
import sdkWasmUrl from 'valhalla-browser/valhalla-browser.wasm?url';
import sdkWorkerUrl from 'valhalla-browser/worker.js?url';

/**
 * Retained decoded-tile cache budget. The two largest Jakarta level-2 tiles measure 48,442,160 B
 * and 37,395,280 B, so the SDK default of 32 MiB refuses to initialize against this dataset at all
 * (`INVALID_REQUEST: Memory budget must fit the largest individual tile in this dataset.`).
 */
export const MEMORY_BUDGET_BYTES = 100663296;
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

export interface RouteClientOptions {
  /** Receives worker progress (runtime, graph, tiles, routing) for the progress indicator. */
  onProgress?: (event: SdkProgress) => void;
}

/** A route client: one lazily created SDK session plus the lifecycle the UI needs. */
export interface RouteClient {
  route(request: RouteRequest, signal?: AbortSignal): Promise<RouteResult>;
  cancel(): void;
  dispose(): Promise<void>;
}

/**
 * Create the application's only SDK session.
 * @param manifestUrl - Versioned dataset manifest URL.
 * @param options - Progress callback for the UI.
 * @returns Route, cancel and dispose bound to one shared `Router`.
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
  };
}
