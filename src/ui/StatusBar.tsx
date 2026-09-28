import { useState } from 'react';
import { PROFILE_LABELS, isResultStale, useScenario } from '../state/scenario';

export { formatBytes, formatDuration, formatKilometers } from './format';
import { formatBytes, formatDuration, formatKilometers } from './format';

export interface StatusBarProps {
  /** Coordinates the route layer holds after the last draw; null before the first route. */
  geometryPoints: number | null;
}

/**
 * The readout strip: dataset identity, active profile, simulated time and the numbers native
 * returned. Every value is a measurement, and an error is printed with its own code and message
 * rather than translated into a friendlier sentence.
 */
export function StatusBar({ geometryPoints }: StatusBarProps) {
  const profile = useScenario(state => state.profile);
  const [details, setDetails] = useState(false);
  const status = useScenario(state => state.status);
  const result = useScenario(state => state.result);
  const error = useScenario(state => state.error);
  const stale = useScenario(isResultStale);

  const summary = result?.native.trip.summary;
  const locations = (result?.native.trip.locations ?? []) as Array<{ date_time?: string; time_zone_name?: string }>;
  const simulated = locations[0]?.date_time;
  const zone = locations[0]?.time_zone_name;
  const loader = result?.diagnostics.loader;

  return (
    <footer data-testid="status-bar" className="nb-panel absolute inset-x-2 bottom-2 z-20 flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-xs md:inset-x-4 md:bottom-4 md:text-sm">
      {stale ? (
        <span data-testid="status-stale" className="border-2 border-nb-black bg-nb-yellow px-1 font-bold">
          Rute usang — belum dihitung ulang
        </span>
      ) : null}
      <Readout secondary={!details} label="Rilis" testId="status-release" value={result?.dataset.release ?? '—'} />
      <Readout secondary={!details} label="Profil" testId="status-profile" value={PROFILE_LABELS[profile]} />
      <Readout secondary={!details} label="Waktu" testId="status-time" value={simulated ? `${simulated}${zone ? ` ${zone}` : ''}` : 'sekarang'} />
      <Readout label="Jarak" testId="status-distance" value={summary ? formatKilometers(summary.length) : '—'} />
      <Readout label="Durasi" testId="status-duration" value={summary ? `${formatDuration(summary.time)} · ${summary.time.toFixed(1)} dtk` : '—'} />
      <Readout secondary={!details} label="Biaya" testId="status-cost" value={summary ? String(Math.round(Number(summary.cost ?? 0))) : '—'} />
      <Readout secondary={!details} label="Byte graf" testId="status-bytes" value={loader ? formatBytes(loader.bytes) : '—'} />
      <Readout secondary={!details} label="Geometri" testId="status-geometry" value={geometryPoints === null ? '—' : `${geometryPoints.toLocaleString('id-ID')} titik`} />
      <button type="button" className="ml-auto font-bold underline md:hidden" aria-expanded={details} onClick={() => setDetails(value => !value)}>
        {details ? 'Ringkas' : 'Detail'}
      </button>
      {error ? (
        <p data-testid="status-error" className="w-full border-t-2 border-nb-black pt-1 font-bold text-nb-terracotta">
          {status === 'cancelled' ? 'Dibatalkan' : 'Galat'}: {error.code}
          {error.nativeCode === undefined ? '' : ` (native ${error.nativeCode})`} — {error.message}
        </p>
      ) : null}
    </footer>
  );
}

/** `secondary` readouts fold away on a phone until "Detail" is pressed, so the bar stays two lines. */
function Readout({ label, value, testId, secondary = false }: { label: string; value: string; testId: string; secondary?: boolean }) {
  return (
    <span className={`whitespace-nowrap${secondary ? ' max-md:hidden' : ''}`}>
      <span className="opacity-60">{label}: </span>
      <strong data-testid={testId}>{value}</strong>
    </span>
  );
}
