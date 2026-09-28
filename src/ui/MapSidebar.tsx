import { CORRIDORS } from '../core/gage-corridors';
import { ACTIVE_COLOR, INACTIVE_COLOR } from '../map/gage-layer';
import { useScenario } from '../state/scenario';
import { useView, type LegLabelMode } from '../state/view';
import { ProcessLog } from './ProcessLog';

const LEG_LABEL_CHOICES: Array<{ value: LegLabelMode; label: string }> = [
  { value: 'off', label: 'Mati' },
  { value: 'speed', label: 'Kecepatan' },
  { value: 'eta', label: 'ETA' },
  { value: 'all', label: 'Semua' },
];

/**
 * The right-hand column: how the map draws the result, what the ganjil-genap colours mean, and the
 * process log. Every control here is display-only (`src/state/view.ts`) and never changes a request.
 */
export function MapSidebar({ onZoomToGage }: { onZoomToGage: () => void }) {
  return (
    <aside className="pointer-events-none absolute bottom-20 right-4 top-4 z-20 flex w-[23rem] max-w-[calc(100vw-1rem)] flex-col gap-2">
      <ViewControls />
      <GageLegend onZoomToGage={onZoomToGage} />
      <ProcessLog className="pointer-events-auto min-h-0 flex-1" />
    </aside>
  );
}

export function ViewControls() {
  const legLabels = useView(state => state.legLabels);
  const animate = useView(state => state.animate);
  const autoRoute = useView(state => state.autoRoute);
  const hasResult = useScenario(state => state.result !== null);
  return (
    <section className="nb-panel pointer-events-auto p-2 text-xs" data-testid="view-controls">
      <h2 className="nb-title text-xs">Tampilan peta</h2>
      <p className="mt-1 font-bold">Label per leg (kecepatan / ETA)</p>
      <div className="mt-1 grid grid-cols-4 gap-1" role="group" aria-label="Label per leg">
        {LEG_LABEL_CHOICES.map(choice => (
          <button
            key={choice.value}
            type="button"
            data-testid={`leg-labels-${choice.value}`}
            aria-pressed={legLabels === choice.value}
            className="nb-button nb-seg min-h-0 px-1 py-1 text-xs"
            onClick={() => useView.getState().setLegLabels(choice.value)}
          >
            {choice.label}
          </button>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <label className="flex flex-1 items-center gap-1">
          <input type="checkbox" data-testid="toggle-animate" className="size-4 accent-nb-terracotta" checked={animate} onChange={event => useView.getState().setAnimate(event.target.checked)} />
          Animasi rute awal → akhir
        </label>
        <button
          type="button"
          data-testid="replay-animation"
          className="nb-button min-h-0 px-2 py-0.5 text-xs"
          disabled={!hasResult}
          onClick={() => useView.getState().replayAnimation()}
        >
          ⟳ Putar ulang
        </button>
      </div>
      <label className="mt-1 flex items-center gap-1">
        <input type="checkbox" data-testid="toggle-auto-route" className="size-4 accent-nb-terracotta" checked={autoRoute} onChange={event => useView.getState().setAutoRoute(event.target.checked)} />
        Hitung ulang otomatis saat titik digeser
      </label>
    </section>
  );
}

export function GageLegend({ onZoomToGage }: { onZoomToGage: () => void }) {
  const showGage = useView(state => state.showGage);
  const gage = useScenario(state => state.gage);
  const avoided = Boolean(gage && gage.excludePolygons.length > 0);
  const color = avoided ? ACTIVE_COLOR : INACTIVE_COLOR;
  return (
    <section className="nb-panel pointer-events-auto p-2 text-xs" data-testid="gage-legend">
      <div className="flex items-center gap-2">
        <span className="nb-hatch" style={{ '--hatch': color } as React.CSSProperties} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 className="nb-title text-xs">Area ganjil-genap</h2>
          <p data-testid="gage-legend-state" className="font-bold" style={{ color: avoided ? '#c8553d' : undefined }}>
            {avoided
              ? `Dihindari pada rute terakhir · ${gage!.excludePolygons.length} ring`
              : `${CORRIDORS.length} ruas Jakarta · tidak dihindari`}
          </p>
        </div>
      </div>
      <ul className="mt-1 space-y-0.5 opacity-80">
        <li><Swatch color={ACTIVE_COLOR} /> merah: plat kena aturan, rute diminta menghindari</li>
        <li><Swatch color={INACTIVE_COLOR} /> kuning: area berlaku, tapi tidak dihindari (plat cocok, di luar jam, dikecualikan, atau Nonaktif)</li>
      </ul>
      <div className="mt-2 flex gap-2">
        <label className="flex flex-1 items-center gap-1">
          <input type="checkbox" data-testid="toggle-gage" className="size-4 accent-nb-terracotta" checked={showGage} onChange={event => useView.getState().setShowGage(event.target.checked)} />
          Tampilkan di peta
        </label>
        <button type="button" data-testid="zoom-gage" className="nb-button min-h-0 px-2 py-0.5 text-xs" onClick={onZoomToGage}>
          Zoom ke area
        </button>
      </div>
    </section>
  );
}

function Swatch({ color }: { color: string }) {
  return <span className="mr-1 inline-block size-2.5 border-2 border-nb-black align-middle" style={{ background: color }} aria-hidden="true" />;
}
