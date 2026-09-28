import { useMemo } from 'react';
import { legFigures, waypointTimes, type LegFigures, type WaypointTime } from '../core/leg-timeline';
import { useScenario } from '../state/scenario';

export interface Timeline {
  legs: LegFigures[];
  /** Empty when the run's start time could not be read. */
  times: WaypointTime[];
}

/**
 * Per-leg figures and per-waypoint clocks for the route on screen, computed from the time control
 * as it was when that route was requested — not as it is now, so editing the departure after a run
 * does not relabel a route that was calculated for another time.
 */
export function useTimeline(): Timeline | null {
  const result = useScenario(state => state.result);
  const clock = useScenario(state => state.resultClock);
  return useMemo(() => {
    if (!result) return null;
    const legs = legFigures(result);
    return { legs, times: clock ? waypointTimes(legs, clock) : [] };
  }, [result, clock]);
}
