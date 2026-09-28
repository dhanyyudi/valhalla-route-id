import { useEffect, useState } from 'react';
import { parsePointInput } from '../core/point-input';
import type { TimeMode } from '../core/request-builder';
import { PROFILE_LABELS, PROFILE_OPTIONS, SLOW_PROFILES, useScenario, withPresetHour, type OptionControl } from '../state/scenario';
import { formatDuration, formatKilometers } from './StatusBar';

/** Preset hours offered under the time control, as agreed in the plan. */
const PRESETS = [6, 7, 12, 17];

const PROGRESS_TEXT: Record<string, string> = {
  'loading-runtime': 'Memuat mesin Valhalla (WASM)…',
  'initializing-graph': 'Menyiapkan graf…',
  'fetching-tile': 'Mengunduh tile graf…',
  routing: 'Menghitung rute…',
};

const TIME_MODES: Array<{ mode: TimeMode; label: string }> = [
  { mode: 'now', label: 'Sekarang' },
  { mode: 'depart', label: 'Berangkat' },
  { mode: 'arrive', label: 'Tiba' },
];

/** Elapsed whole seconds since `running` became true. */
function useElapsed(running: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) {
      setSeconds(0);
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return seconds;
}

/**
 * The inspector's control surface: waypoints, profile, time and the small costing-option set,
 * plus the run/cancel actions and the turn-by-turn list.
 */
export function RoutePanel() {
  const [collapsed, setCollapsed] = useState(false);
  const waypoints = useScenario(state => state.waypoints);
  const profile = useScenario(state => state.profile);
  const timeMode = useScenario(state => state.timeMode);
  const departure = useScenario(state => state.departure);
  const status = useScenario(state => state.status);
  const error = useScenario(state => state.error);
  const progress = useScenario(state => state.progress);
  const result = useScenario(state => state.result);
  const elapsed = useElapsed(status === 'routing');

  const slow = SLOW_PROFILES.includes(profile);
  const maneuvers = (result?.native.trip.legs ?? []).flatMap(leg => leg.maneuvers);
  const summary = result?.native.trip.summary;

  return (
    <section
      data-testid="route-panel"
      className="nb-panel absolute left-2 top-2 z-20 max-h-[calc(100dvh-7rem)] w-[22rem] max-w-[calc(100vw-1rem)] overflow-y-auto p-3 text-sm md:left-4 md:top-4 md:p-4"
    >
      <header className="flex items-start justify-between gap-2">
        <div>
          <h1 className="nb-title text-lg">Valhalla Route ID</h1>
          <p className="text-xs opacity-70">Inspector rute Indonesia — Valhalla berjalan di browser.</p>
        </div>
        <button
          type="button"
          data-testid="toggle-panel"
          aria-expanded={!collapsed}
          className="nb-button shrink-0 px-2 py-1 text-xs"
          onClick={() => setCollapsed(value => !value)}
        >
          {collapsed ? 'Buka' : 'Tutup'}
        </button>
      </header>

      {collapsed ? (
        <p className="mt-2 text-xs opacity-70">{waypoints.length} titik · {PROFILE_LABELS[profile]}</p>
      ) : (
        <>
          <Waypoints />
          <Profiles />
          <TimeControl timeMode={timeMode} departure={departure} />
          <Options key={profile} profile={profile} />

          {status === 'routing' ? (
            <p data-testid="progress" role="status" className="mt-2 font-bold">
              {PROGRESS_TEXT[progress?.phase ?? 'routing'] ?? 'Bekerja…'}
              {progress?.tileId ? ` · tile ${progress.tileId}` : ''} · {formatDuration(elapsed)}
            </p>
          ) : null}

          {slow ? (
            <p data-testid="route-warning" className="mt-2 border-3 border-nb-black bg-nb-yellow p-2 font-bold">
              Profil {PROFILE_LABELS[profile]} sangat lambat di runtime ini: rute pendek pun bisa melewati batas waktu.
              Gunakan Mobil atau Motor.
            </p>
          ) : null}

          {error ? (
            <p data-testid="panel-error" role="alert" className="mt-2 border-3 border-nb-black bg-nb-cream p-2 font-bold text-nb-terracotta">
              {error.code}
              {error.nativeCode === undefined ? '' : ` (native ${error.nativeCode})`}: {error.message}
              {error.code === 'TIMEOUT' ? ' Profil ini terlalu lambat di sini — coba Mobil atau Motor.' : ''}
            </p>
          ) : null}

          {summary ? (
            <section className="mt-3 border-t-3 border-nb-black pt-2">
              <h2 className="nb-title text-sm">Hasil</h2>
              <p data-testid="result-summary">
                {formatKilometers(summary.length)} · {formatDuration(summary.time)} · biaya {Math.round(Number(summary.cost ?? 0))}
              </p>
              <h3 className="nb-title mt-2 text-xs">Petunjuk arah (English)</h3>
              <p className="text-xs opacity-70">
                Biner WASM ini hanya memuat locale en-US, jadi instruksi selalu bahasa Inggris; seluruh antarmuka tetap Bahasa Indonesia.
              </p>
              <ol data-testid="instructions" className="mt-1 max-h-56 overflow-y-auto pr-1">
                {maneuvers.map((maneuver, index) => (
                  <li key={index} className="border-b-2 border-dashed border-nb-black/30 py-1">
                    <span className="font-bold">{maneuver.instruction}</span>
                    <span className="block font-mono text-xs opacity-70">
                      {maneuver.length.toLocaleString('id-ID', { maximumFractionDigits: 3 })} km · {formatDuration(maneuver.time)}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {/*
            The action row is the last child of the scrolling panel on purpose. `sticky bottom-0`
            only pins an element while its static position is below the scrollport, so anything
            rendered after it (the progress line, whose elapsed counter changes width every second)
            kept pushing it around — visible, but never stable enough to click while a route ran.
          */}
          <div className="sticky bottom-0 mt-3 flex gap-2 bg-nb-cream pt-1">
            <button
              type="button"
              data-testid="run"
              className="nb-button flex-1"
              disabled={waypoints.length < 2 || status === 'routing'}
              onClick={() => void useScenario.getState().run()}
            >
              {status === 'routing' ? 'Menghitung…' : 'Hitung rute'}
            </button>
            {status === 'routing' ? (
              <button
                type="button"
                data-testid="cancel"
                className="nb-button bg-nb-terracotta text-nb-cream"
                onClick={() => useScenario.getState().cancel()}
              >
                Batal
              </button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

function Waypoints() {
  const [text, setText] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const waypoints = useScenario(state => state.waypoints);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = parsePointInput(text);
    if (!parsed.ok) {
      setMessage(parsed.message);
      return;
    }
    useScenario.getState().addWaypoint(parsed.point);
    setText('');
    setMessage(null);
  };

  return (
    <section className="mt-3 border-t-3 border-nb-black pt-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="nb-title text-sm">Titik ({waypoints.length})</h2>
        <div className="flex gap-1">
          <button
            type="button"
            className="nb-button px-2 py-1 text-xs"
            disabled={waypoints.length < 2}
            onClick={() => useScenario.getState().reverseWaypoints()}
          >
            Balik urutan
          </button>
          <button
            type="button"
            data-testid="clear-waypoints"
            className="nb-button px-2 py-1 text-xs"
            disabled={waypoints.length === 0}
            onClick={() => useScenario.getState().clearWaypoints()}
          >
            Hapus titik
          </button>
        </div>
      </div>

      {waypoints.length === 0 ? (
        <p className="mt-1 text-xs opacity-70">Klik peta untuk menambah titik, atau tempel koordinat / tautan Google Maps.</p>
      ) : (
        <ol className="mt-1">
          {waypoints.map((point, index) => (
            <li key={`${point.lat},${point.lng},${index}`} className="flex items-center gap-2 border-b-2 border-dashed border-nb-black/30 py-1">
              <span className="nb-badge">{index + 1}</span>
              <span className="font-mono text-xs">{point.lat.toFixed(5)}, {point.lng.toFixed(5)}</span>
              <button
                type="button"
                aria-label={`Hapus titik ${index + 1}`}
                data-testid={`remove-waypoint-${index}`}
                className="nb-button ml-auto px-2 py-0.5 text-xs"
                onClick={() => useScenario.getState().removeWaypoint(index)}
              >
                ×
              </button>
            </li>
          ))}
        </ol>
      )}

      <form className="mt-2 flex gap-1" onSubmit={submit}>
        <input
          aria-label="Tempel koordinat atau tautan Google Maps"
          data-testid="paste-input"
          className="nb-input min-w-0 flex-1 text-xs"
          placeholder="-6.1754, 106.8272 atau tautan Maps"
          value={text}
          onChange={event => setText(event.target.value)}
        />
        <button type="submit" data-testid="paste-add" className="nb-button px-2 py-1 text-xs">Tambah</button>
      </form>
      {message ? <p role="alert" className="mt-1 text-xs font-bold text-nb-terracotta">{message}</p> : null}
    </section>
  );
}

function Profiles() {
  const profile = useScenario(state => state.profile);
  return (
    <section className="mt-3 border-t-3 border-nb-black pt-2">
      <h2 className="nb-title text-sm">Profil</h2>
      <div className="mt-1 grid grid-cols-3 gap-1">
        {Object.entries(PROFILE_LABELS).map(([value, label]) => (
          <button
            key={value}
            type="button"
            data-testid={`profile-${value}`}
            aria-pressed={profile === value}
            className="nb-button nb-seg px-1 py-1 text-xs"
            onClick={() => useScenario.getState().setProfile(value as keyof typeof PROFILE_LABELS)}
          >
            {label}
            {SLOW_PROFILES.includes(value as keyof typeof PROFILE_LABELS) ? ' 🐌' : ''}
          </button>
        ))}
      </div>
    </section>
  );
}

function TimeControl({ timeMode, departure }: { timeMode: TimeMode; departure: string }) {
  return (
    <section className="mt-3 border-t-3 border-nb-black pt-2">
      <h2 className="nb-title text-sm">Waktu (waktu lokal dataset)</h2>
      <div className="mt-1 grid grid-cols-3 gap-1">
        {TIME_MODES.map(({ mode, label }) => (
          <button
            key={mode}
            type="button"
            data-testid={`time-${mode}`}
            aria-pressed={timeMode === mode}
            className="nb-button nb-seg px-1 py-1 text-xs"
            onClick={() => useScenario.getState().setTime(mode)}
          >
            {label}
          </button>
        ))}
      </div>
      <input
        type="datetime-local"
        aria-label="Waktu keberangkatan atau kedatangan"
        data-testid="departure-input"
        className="nb-input mt-2 w-full text-xs"
        value={departure}
        disabled={timeMode === 'now'}
        onChange={event => useScenario.getState().setTime(timeMode, event.target.value)}
      />
      <div className="mt-1 flex flex-wrap gap-1">
        {PRESETS.map(hour => (
          <button
            key={hour}
            type="button"
            data-testid={`preset-${hour}`}
            className="nb-button px-2 py-1 text-xs"
            onClick={() => useScenario.getState().setTime(timeMode === 'now' ? 'depart' : timeMode, withPresetHour(departure, hour))}
          >
            {String(hour).padStart(2, '0')}:00
          </button>
        ))}
      </div>
    </section>
  );
}

function Options({ profile }: { profile: keyof typeof PROFILE_OPTIONS }) {
  return (
    <section className="mt-3 border-t-3 border-nb-black pt-2">
      <h2 className="nb-title text-sm">Opsi costing ({PROFILE_LABELS[profile]})</h2>
      <div className="mt-1 space-y-1">
        {PROFILE_OPTIONS[profile].map(control => <OptionRow key={control.key} control={control} />)}
      </div>
    </section>
  );
}

function OptionRow({ control }: { control: OptionControl }) {
  if (control.kind === 'preference') return <PreferenceOption control={control} />;
  if (control.kind === 'boolean') return <BooleanOption control={control} />;
  return <NumberOption control={control} />;
}

function PreferenceOption({ control }: { control: OptionControl }) {
  const value = useScenario(state => state.options[control.key]);
  return (
    <label className="flex items-center justify-between gap-2 text-xs">
      <span>{control.label}</span>
      <select
        data-testid={`option-${control.key}`}
        className="nb-input py-0.5"
        value={value === undefined ? '' : String(value)}
        onChange={event => useScenario.getState().setOption(control.key, event.target.value === '' ? undefined : Number(event.target.value))}
      >
        <option value="">Bawaan</option>
        <option value="0">Hindari</option>
        <option value="1">Utamakan</option>
      </select>
    </label>
  );
}

function BooleanOption({ control }: { control: OptionControl }) {
  const value = useScenario(state => state.options[control.key]);
  return (
    <label className="flex items-center justify-between gap-2 text-xs">
      <span>{control.label}</span>
      <input
        type="checkbox"
        data-testid={`option-${control.key}`}
        className="size-5 accent-nb-terracotta"
        checked={value === true}
        onChange={event => useScenario.getState().setOption(control.key, event.target.checked ? true : undefined)}
      />
    </label>
  );
}

function NumberOption({ control }: { control: OptionControl }) {
  const value = useScenario(state => state.options[control.key]);
  const [text, setText] = useState(value === undefined ? '' : String(value));
  return (
    <label className="flex items-center justify-between gap-2 text-xs">
      <span>{control.label}{control.unit ? ` (${control.unit})` : ''}</span>
      <input
        type="number"
        inputMode="decimal"
        min="0"
        step="any"
        data-testid={`option-${control.key}`}
        className="nb-input w-24 py-0.5"
        placeholder={control.placeholder ?? ''}
        value={text}
        onChange={event => {
          const next = event.target.value;
          setText(next);
          const parsed = Number(next);
          useScenario.getState().setOption(control.key, next.trim() === '' || !Number.isFinite(parsed) || parsed <= 0 ? undefined : parsed);
        }}
      />
    </label>
  );
}
