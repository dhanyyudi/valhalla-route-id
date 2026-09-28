import { useEffect, useMemo, useState } from 'react';
import { describeCrossings } from '../core/gage-crossing';
import { wibInstant } from '../core/gage-request';
import { parsePointInput } from '../core/point-input';
import type { TimeMode } from '../core/request-builder';
import type { PlateParity } from '../core/ganjil-genap';
import { legFigures } from '../core/leg-timeline';
import { encodeScenario } from '../core/share-url';
import { legColor, routeTrack } from '../map/route-layer';
import { PROFILE_LABELS, PROFILE_OPTIONS, SLOW_PROFILES, useScenario, withPresetHour, type OptionControl } from '../state/scenario';
import { formatDuration, formatKilometers, formatShortDuration, formatSpeed } from './format';
import { copyText } from './Toast';
import { useTimeline, type Timeline } from './useTimeline';

/** Preset hours offered under the time control, as agreed in the plan. */
const PRESETS = [6, 7, 12, 17];

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
  const result = useScenario(state => state.result);
  const elapsed = useElapsed(status === 'routing');
  const timeline = useTimeline();

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
          <GanjilGenap />
          <Options key={profile} profile={profile} />

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
              {timeline ? <LegTable timeline={timeline} /> : null}
              <ShareRow />
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
              {status === 'routing' ? `Menghitung… ${formatDuration(elapsed)}` : 'Hitung rute'}
            </button>
            <button
              type="button"
              data-testid="copy-url"
              title="Salin URL skenario ini (titik, profil, waktu, ganjil-genap, opsi)"
              className="nb-button px-2 text-xs"
              disabled={waypoints.length === 0}
              onClick={() => void copyText(shareUrl(), 'URL rute')}
            >
              🔗 URL
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
  const timeline = useTimeline();
  const resultStops = useScenario(state => (state.result ? state.result.native.trip.legs.length + 1 : 0));
  // Clocks belong to the route on screen: once a stop is added or removed they no longer line up.
  const times = timeline && resultStops === waypoints.length ? timeline.times : [];

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
        <>
        <p className="mt-1 text-xs opacity-70">Seret marker untuk memindah titik (rute dihitung ulang otomatis) · klik kanan marker untuk menghapus.</p>
        <ol className="mt-1">
          {waypoints.map((point, index) => (
            <li key={`${point.lat},${point.lng},${index}`} className="flex items-center gap-2 border-b-2 border-dashed border-nb-black/30 py-1">
              <span className="nb-badge">{index + 1}</span>
              <span className="font-mono text-xs">{point.lat.toFixed(5)}, {point.lng.toFixed(5)}</span>
              {times[index] ? (
                <span data-testid={`waypoint-clock-${index}`} className="nb-chip" title={index === 0 ? 'Waktu berangkat' : index === waypoints.length - 1 ? 'Perkiraan tiba' : 'Perkiraan tiba/lanjut'}>
                  {index === 0 ? 'berangkat' : 'tiba'} {times[index].clock}
                </span>
              ) : null}
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
        </>
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
  // A cleared or half-typed `datetime-local` box must look wrong here, not only in the verdict
  // below: `planGageRequest` refuses to evaluate the rule without a readable time (M-6).
  const invalid = timeMode !== 'now' && wibInstant(departure) === null;
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
        className={`nb-input mt-2 w-full text-xs${invalid ? ' border-nb-terracotta' : ''}`}
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

/** The three states the parity control offers, in the panel's own Indonesian. */
const PARITY_CHOICES: Array<{ value: PlateParity; label: string }> = [
  { value: 'odd', label: 'Ganjil' },
  { value: 'even', label: 'Genap' },
  { value: 'off', label: 'Nonaktif' },
];

/** Indonesian label and colour for each verdict the rule can return. */
const STATUS_TEXT: Record<string, string> = {
  exempt_profile: 'Dikecualikan',
  inactive_time: 'Tidak berlaku',
  allowed: 'Boleh melintas',
  restricted: 'Kena ganjil-genap',
};

/**
 * The ganjil-genap block: plate parity, the rule's verdict for the simulated time, what the request
 * is doing about it, and — after a route — which corridors the returned geometry still crosses.
 *
 * The verdict is derived from the scenario on every render (`gagePlan` is a bounding-box test over
 * 30 rings), so the status never contradicts the time control or the profile next to it.
 */
function GanjilGenap() {
  const plateParity = useScenario(state => state.plateParity);
  const profile = useScenario(state => state.profile);
  const timeMode = useScenario(state => state.timeMode);
  const departure = useScenario(state => state.departure);
  const waypoints = useScenario(state => state.waypoints);
  const result = useScenario(state => state.result);
  const gage = useScenario(state => state.gage);
  const crossings = useScenario(state => state.crossings);

  // Re-derived from the current controls rather than remembered, so changing the hour or the plate
  // updates the verdict immediately. `gagePlan()` reads `result` and `waypoints` through the store,
  // so both are dependencies: without `waypoints` the panel kept saying "Semua titik berada di luar
  // area Jakarta" while a Jakarta stop was being added, before the first route existed.
  const plan = useMemo(
    () => useScenario.getState().gagePlan(),
    [plateParity, profile, timeMode, departure, waypoints, result],
  );

  // Distinct corridors the request asked to avoid — `excluded` and `partial` never name the same
  // corridor, so the sum is the corridor count the sentence interpolates, not a ring count.
  const avoidedCorridors = plan.excluded.length + plan.partial.length;
  return (
    <section className="mt-3 border-t-3 border-nb-black pt-2" data-testid="gage-block">
      <h2 className="nb-title text-sm">Ganjil-genap</h2>
      <div className="mt-1 grid grid-cols-3 gap-1">
        {PARITY_CHOICES.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            data-testid={`parity-${value}`}
            aria-pressed={plateParity === value}
            className="nb-button nb-seg px-1 py-1 text-xs"
            onClick={() => useScenario.getState().setPlateParity(value)}
          >
            {label}
          </button>
        ))}
      </div>

      <p data-testid="gage-status" className="mt-2 text-xs font-bold">
        Status: {plan.evaluation ? STATUS_TEXT[plan.evaluation.status] ?? plan.evaluation.status : 'tidak dievaluasi'}
        {plan.evaluation?.window ? ` · ${plan.evaluation.window.label} ${plan.evaluation.window.startHour}:00–${plan.evaluation.window.endHour}:00 WIB` : ''}
        {plan.evaluation
          ? ` · ${plan.evaluation.parts.isoDate} ${String(plan.evaluation.parts.hour).padStart(2, '0')}:${String(plan.evaluation.parts.minute).padStart(2, '0')} WIB`
          : ''}
      </p>
      <p data-testid="gage-reason" className="mt-1 text-xs opacity-80">
        {plan.evaluation?.reason ?? plan.refusal ?? ''}
      </p>

      {plan.refusal ? (
        <p data-testid="gage-caution" role="alert" className="mt-1 font-bold text-nb-terracotta">
          Isi waktu keberangkatan/kedatangan yang valid, atau pilih "Sekarang": selama tidak ada waktu
          yang terbaca, ganjil-genap tidak dievaluasi dan rute tidak dihitung.
        </p>
      ) : null}

      {plan.restricted ? (
        <p data-testid="gage-request" className="mt-1 text-xs">
          {result
            ? `Perkiraan bila rute ini dijalankan ulang: exclude_polygons ${plan.excludePolygons.length} ring (${(plan.perimeterMeters / 1000).toFixed(1)} km dari batas 10 km per permintaan).`
            : `Perkiraan permintaan: exclude_polygons ${plan.excludePolygons.length} ring (${(plan.perimeterMeters / 1000).toFixed(1)} km dari batas 10 km per permintaan).`}
          {plan.excluded.length > 0 ? ` Ruas utuh: ${plan.excluded.map(corridor => corridor.name).join(', ')}.` : ''}
          {plan.partial.length > 0
            ? ` Sebagian (bukan seluruh ruas): ${plan.partial.map(entry => `${entry.corridor.name} potongan ${entry.ringIndexes.map(index => index + 1).join('/')}`).join(', ')}.`
            : ''}
        </p>
      ) : (
        <p data-testid="gage-request" className="mt-1 text-xs opacity-80">Permintaan tidak membawa exclude_polygons.</p>
      )}

      {/*
        What the last run actually sent, which is not always what the line above says: before the
        first route the plan is built from the waypoints, and after it from the route geometry, so a
        second run of the same scenario can legitimately carry different rings. Showing only the
        recomputed plan let the panel name Jl. Sudirman for a ring that belonged to Jl. Rasuna Said.
      */}
      {gage && gage.excludePolygons.length > 0 ? (
        <p data-testid="gage-sent" className="mt-1 text-xs opacity-80">
          Dikirim pada rute terakhir: {gage.excludePolygons.length} ring ({(gage.perimeterMeters / 1000).toFixed(1)} km dari batas 10 km per permintaan)
          {gage.partial.length > 0
            ? ` — sebagian: ${gage.partial.map(entry => `${entry.corridor.name} potongan ${entry.ringIndexes.map(index => index + 1).join('/')}`).join(', ')}`
            : ''}
          {gage.excluded.length > 0 ? ` — utuh: ${gage.excluded.map(corridor => corridor.name).join(', ')}` : ''}.
        </p>
      ) : null}

      {result && crossings ? (
        <p data-testid="gage-crossing" className="mt-1 text-xs font-bold">
          {describeCrossings(crossings, avoidedCorridors)}
        </p>
      ) : null}
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

/** The inspector's own URL for the current scenario, as `src/core/share-url.ts` encodes it. */
function shareUrl(): string {
  const { waypoints, profile, timeMode, departure, plateParity, options } = useScenario.getState();
  const numeric = Object.fromEntries(Object.entries(options).filter(([, value]) => typeof value !== 'string')) as Record<string, number | boolean>;
  const query = encodeScenario({ waypoints, profile, timeMode, departure, plateParity, options: numeric });
  return `${location.origin}${location.pathname}${query ? `?${query}` : ''}`;
}

/** Distance, time, mean speed and arrival clock for every leg, keyed to the map's leg colours. */
function LegTable({ timeline }: { timeline: Timeline }) {
  const { legs, times } = timeline;
  return (
    <div className="mt-2 overflow-x-auto">
      <table data-testid="leg-table" className="w-full border-collapse text-xs [&_td]:px-1 [&_th]:px-1">
        <thead>
          <tr className="text-left">
            <th className="py-0.5 pr-1">Leg</th>
            <th className="py-0.5 pr-1 text-right">Jarak</th>
            <th className="py-0.5 pr-1 text-right">Waktu</th>
            <th className="py-0.5 pr-1 text-right">⌀ Kec.</th>
            <th className="py-0.5 text-right">Tiba</th>
          </tr>
        </thead>
        <tbody>
          {legs.map(leg => (
            <tr key={leg.index} data-testid={`leg-row-${leg.index}`} className="border-t-2 border-dashed border-nb-black/30">
              <td className="py-0.5 pr-1 font-bold whitespace-nowrap">
                <span className="mr-1 inline-block h-2.5 w-4 border-2 border-nb-black align-middle" style={{ background: legColor(leg.index) }} aria-hidden="true" />
                {leg.index + 1}→{leg.index + 2}
              </td>
              <td className="py-0.5 pr-1 text-right font-mono whitespace-nowrap">{formatKilometers(leg.lengthKm)}</td>
              <td className="py-0.5 pr-1 text-right font-mono whitespace-nowrap">{formatShortDuration(leg.timeSeconds)}</td>
              <td className="py-0.5 pr-1 text-right font-mono whitespace-nowrap">{formatSpeed(leg.speedKmh)}</td>
              <td className="py-0.5 text-right font-mono font-bold">{times[leg.index + 1]?.clock ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {times.length > 0 ? (
        <p className="mt-1 text-xs opacity-70">
          Berangkat {times[0].local.replace('T', ' ')} · jam dihitung dari waktu tempuh native tanpa waktu singgah.
        </p>
      ) : null}
    </div>
  );
}

/** Copy the scenario URL, the exact request JSON, or the route as GeoJSON. */
function ShareRow() {
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      <button type="button" data-testid="copy-url-result" className="nb-button min-h-0 px-2 py-1 text-xs" onClick={() => void copyText(shareUrl(), 'URL rute')}>
        Salin URL rute
      </button>
      <button
        type="button"
        data-testid="copy-request"
        className="nb-button min-h-0 px-2 py-1 text-xs"
        onClick={() => void copyText(JSON.stringify(window.valhallaLastRequest?.() ?? null, null, 2), 'JSON permintaan Valhalla')}
      >
        Salin JSON permintaan
      </button>
      <button type="button" data-testid="copy-geojson" className="nb-button min-h-0 px-2 py-1 text-xs" onClick={() => void copyText(routeGeoJson(), 'GeoJSON rute')}>
        Salin GeoJSON
      </button>
    </div>
  );
}

/** The route on screen as a FeatureCollection: one LineString per leg, one Point per stop. */
function routeGeoJson(): string {
  const { result, waypoints } = useScenario.getState();
  if (!result) return '';
  const track = routeTrack(result);
  const legs = legFigures(result);
  return JSON.stringify({
    type: 'FeatureCollection',
    features: [
      ...track.legs.map((leg, index) => ({
        type: 'Feature',
        properties: { leg: index + 1, color: legColor(index), length_km: legs[index]?.lengthKm, time_s: legs[index]?.timeSeconds },
        geometry: { type: 'LineString', coordinates: leg.coordinates },
      })),
      ...waypoints.map((point, index) => ({ type: 'Feature', properties: { waypoint: index + 1 }, geometry: { type: 'Point', coordinates: [point.lng, point.lat] } })),
    ],
  });
}
