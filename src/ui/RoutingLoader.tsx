import { useEffect, useState } from 'react';
import type { ProgressEvent as SdkProgress } from 'valhalla-browser';
import { useProcessLog } from '../state/process-log';
import { PROFILE_LABELS, useScenario } from '../state/scenario';
import { formatDuration } from './format';
import { useExplainer } from './WasmExplainer';

/** The progress line's own wording; `e2e/*.spec.ts` reads it, including the ` · tile <id>` part. */
export const PROGRESS_TEXT: Record<string, string> = {
  'loading-runtime': 'Memuat mesin Valhalla (WASM)…',
  'initializing-graph': 'Menyiapkan graf…',
  'fetching-tile': 'Mengunduh tile graf…',
  routing: 'Menghitung rute…',
};

type Phase = SdkProgress['phase'];

/** Steps in the order a cold session goes through them. */
const STEPS: Array<{ phases: Phase[]; title: string; hint: string }> = [
  { phases: ['loading-runtime'], title: 'Mesin WASM', hint: 'Unduh & kompilasi Valhalla ke WebAssembly' },
  { phases: ['initializing-graph'], title: 'Indeks graf', hint: 'Header dan indeks arsip tile' },
  { phases: ['routing', 'fetching-tile'], title: 'Pencarian rute', hint: 'A* di graf; tile diunduh sesuai kebutuhan' },
];

/** 100 ms ticks while `running`, as elapsed milliseconds. */
function useTicker(running: boolean, since: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [running]);
  return running && since ? Math.max(0, now - since) : 0;
}

/**
 * The routing loader: which stage the WASM worker is in, how long it has taken, how many graph
 * tiles it has read, and a way to stop it or read the full log.
 *
 * Stages come from the SDK's own progress events (`src/state/process-log.ts`). A warm session skips
 * the first two, which the stepper shows as "siap" rather than pretending they ran again.
 */
export function RoutingLoader() {
  const status = useScenario(state => state.status);
  const progress = useScenario(state => state.progress);
  const profile = useScenario(state => state.profile);
  const waypoints = useScenario(state => state.waypoints.length);
  const rerunQueued = useScenario(state => state.rerunQueued);
  const run = useProcessLog(state => state.run);
  const routing = status === 'routing';
  const elapsed = useTicker(routing, run?.startedAt);
  if (!routing) return null;

  const current = progress?.phase ?? null;
  const currentStep = current ? STEPS.findIndex(step => step.phases.includes(current)) : -1;
  const seen = (step: (typeof STEPS)[number]) => step.phases.some(phase => run?.phases[phase] !== undefined);
  const phaseText = PROGRESS_TEXT[current ?? 'routing'] ?? 'Bekerja…';
  const seconds = Math.floor(elapsed / 1000);
  // A cold session is loading the engine or reading the graph index: the slow, one-off part.
  const cold = run?.phases['loading-runtime'] !== undefined || (run?.tiles ?? 0) > 0;

  return (
    <section
      data-testid="routing-loader"
      aria-live="polite"
      className="nb-panel nb-loader absolute left-1/2 top-3 z-30 w-[min(30rem,calc(100vw-1rem))] -translate-x-1/2 p-3 text-sm max-md:top-auto max-md:bottom-20"
    >
      <div className="flex items-center gap-3">
        <RouteGlyph />
        <div className="min-w-0 flex-1">
          <p className="nb-title text-sm">Valhalla WASM bekerja</p>
          <p data-testid="progress" role="status" className="truncate font-bold">
            {phaseText}
            {progress?.tileId ? ` · tile ${progress.tileId}` : ''} · {formatDuration(seconds)}
          </p>
          <p className="text-xs opacity-70">
            {waypoints} titik · {PROFILE_LABELS[profile]} · {(elapsed / 1000).toFixed(1)} dtk
            {rerunQueued ? ' · rute ulang menunggu' : ''}
          </p>
        </div>
        <div className="text-right">
          <p className="nb-title text-2xl leading-none" data-testid="loader-tiles">{run?.tiles ?? 0}</p>
          <p className="text-[0.65rem] font-bold uppercase opacity-70">tile</p>
        </div>
      </div>

      <ol className="mt-3 grid grid-cols-3 gap-1">
        {STEPS.map((step, index) => {
          const state = index === currentStep ? 'active' : seen(step) || index < currentStep ? 'done' : 'pending';
          const skipped = state === 'done' && !seen(step);
          return (
            <li key={step.title} data-state={state} className="nb-step" title={step.hint}>
              <span className="nb-step-icon" aria-hidden="true">{state === 'done' ? '✓' : state === 'active' ? '' : index + 1}</span>
              <span className="block font-bold leading-tight">{step.title}</span>
              <span className="block text-[0.65rem] leading-tight opacity-70">
                {state === 'active' ? (step.phases.includes('fetching-tile') && run?.lastTile ? `tile ${run.lastTile}` : 'berjalan…') : skipped ? 'siap (sesi hangat)' : state === 'done' ? 'selesai' : 'menunggu'}
              </span>
            </li>
          );
        })}
      </ol>

      <div className="nb-bar mt-3" aria-hidden="true"><span /></div>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          data-testid="loader-why"
          className={`nb-button px-2 py-1 text-xs ${cold ? 'bg-nb-cream' : ''}`}
          onClick={() => useExplainer.getState().setOpen(true)}
        >
          {cold ? 'Kenapa lama?' : 'Cara kerja'}
        </button>
        <button type="button" className="nb-button flex-1 px-2 py-1 text-xs" onClick={() => useProcessLog.getState().setOpen(true)}>
          Lihat log proses
        </button>
        <button
          type="button"
          data-testid="loader-cancel"
          className="nb-button bg-nb-terracotta px-2 py-1 text-xs text-nb-cream"
          onClick={() => useScenario.getState().cancel()}
        >
          Batal
        </button>
      </div>
    </section>
  );
}

/** A little road with a vehicle driving along it, looping while the engine works. */
function RouteGlyph() {
  return (
    <svg viewBox="0 0 64 40" className="nb-glyph h-10 w-16 shrink-0" aria-hidden="true">
      <path d="M4 32 C 18 32, 18 8, 32 8 S 46 32, 60 32" fill="none" stroke="#111111" strokeWidth="7" strokeLinecap="round" />
      <path className="nb-glyph-road" d="M4 32 C 18 32, 18 8, 32 8 S 46 32, 60 32" fill="none" stroke="#f2c14e" strokeWidth="2" strokeDasharray="4 4" strokeLinecap="round" />
      <circle r="4.5" fill="#f5efe6" stroke="#111111" strokeWidth="2">
        <animateMotion dur="1.6s" repeatCount="indefinite" path="M4 32 C 18 32, 18 8, 32 8 S 46 32, 60 32" />
      </circle>
    </svg>
  );
}
