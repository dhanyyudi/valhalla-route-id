import { create } from 'zustand';

/**
 * Display preferences: how the result is drawn, never what is requested.
 *
 * Nothing here reaches the route request, so toggling any of it can never change a route; it is
 * kept out of the scenario store for exactly that reason. The choices persist per browser.
 */

/** What each leg's on-map label shows. */
export type LegLabelMode = 'off' | 'speed' | 'eta' | 'all';

export interface ViewState {
  legLabels: LegLabelMode;
  /** Draw the route from the first stop to the last when a new result arrives. */
  animate: boolean;
  /** Re-route as soon as a dragged marker is dropped. */
  autoRoute: boolean;
  /** Ganjil-genap corridors on the map. */
  showGage: boolean;
  /** Bumped to replay the route animation. */
  replay: number;
  setLegLabels(mode: LegLabelMode): void;
  setAnimate(animate: boolean): void;
  setAutoRoute(autoRoute: boolean): void;
  setShowGage(showGage: boolean): void;
  replayAnimation(): void;
}

const STORAGE_KEY = 'valhalla-route-id:view';

type Stored = Pick<ViewState, 'legLabels' | 'animate' | 'autoRoute' | 'showGage'>;

const DEFAULTS: Stored = { legLabels: 'all', animate: true, autoRoute: true, showGage: true };

function load(): Stored {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Stored>;
    return {
      legLabels: ['off', 'speed', 'eta', 'all'].includes(parsed.legLabels as string) ? (parsed.legLabels as LegLabelMode) : DEFAULTS.legLabels,
      animate: typeof parsed.animate === 'boolean' ? parsed.animate : DEFAULTS.animate,
      autoRoute: typeof parsed.autoRoute === 'boolean' ? parsed.autoRoute : DEFAULTS.autoRoute,
      showGage: typeof parsed.showGage === 'boolean' ? parsed.showGage : DEFAULTS.showGage,
    };
  } catch {
    return DEFAULTS;
  }
}

function save(state: ViewState): void {
  try {
    const { legLabels, animate, autoRoute, showGage } = state;
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({ legLabels, animate, autoRoute, showGage }));
  } catch {
    // Storage can be unavailable (private windows, blocked site data); preferences then last one visit.
  }
}

export const useView = create<ViewState>((set, get) => ({
  ...load(),
  replay: 0,
  setLegLabels(legLabels) { set({ legLabels }); save(get()); },
  setAnimate(animate) { set({ animate }); save(get()); },
  setAutoRoute(autoRoute) { set({ autoRoute }); save(get()); },
  setShowGage(showGage) { set({ showGage }); save(get()); },
  replayAnimation() { set({ replay: get().replay + 1 }); },
}));
