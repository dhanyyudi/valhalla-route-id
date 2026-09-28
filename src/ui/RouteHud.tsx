import { naiveLocal, naiveMillis } from '../core/leg-timeline';
import type { AnimationFrame } from '../map/route-layer';
import { legColor } from '../map/route-layer';
import { formatSpeed } from './format';
import { useTimeline } from './useTimeline';

/**
 * The route animation's readout: the simulated clock, the leg being driven and how far along the
 * trip the vehicle is. The clock is the first stop's time plus native's trip seconds, the same
 * arithmetic the waypoint badges use, so it lands on each badge's minute as it passes.
 */
export function RouteHud({ frame }: { frame: AnimationFrame | null }) {
  const timeline = useTimeline();
  if (!frame || frame.done || !timeline) return null;
  const start = timeline.times[0] ? naiveMillis(timeline.times[0].local) : null;
  const clock = start === null ? null : naiveLocal(start + frame.seconds * 1000).slice(11, 16);
  const leg = timeline.legs[frame.leg];
  return (
    <div
      data-testid="route-hud"
      className="nb-panel pointer-events-none absolute left-1/2 top-3 z-20 w-[min(22rem,calc(100vw-1rem))] -translate-x-1/2 px-3 py-2 text-xs max-md:top-auto max-md:bottom-20"
    >
      <div className="flex items-center gap-3">
        <span className="nb-title text-xl leading-none">{clock ?? '—'}</span>
        <span className="flex-1">
          <span className="font-bold">Simulasi perjalanan</span>
          <span className="block opacity-70">
            Leg {frame.leg + 1}/{timeline.legs.length}
            {leg ? ` · ⌀ ${formatSpeed(leg.speedKmh)}` : ''}
          </span>
        </span>
        <span className="font-mono font-bold">{Math.round(frame.progress * 100)}%</span>
      </div>
      <div className="mt-2 h-2 border-2 border-nb-black bg-nb-cream">
        <div className="h-full" style={{ width: `${frame.progress * 100}%`, background: legColor(frame.leg) }} />
      </div>
    </div>
  );
}
