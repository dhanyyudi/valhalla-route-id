import { useEffect, useRef, useState } from 'react';
import { formatEntry, useProcessLog, type LogLevel } from '../state/process-log';
import { copyText } from './Toast';

const LEVEL_CLASS: Record<LogLevel, string> = {
  info: 'text-[#cfd8dc]',
  phase: 'text-[#f2c14e]',
  tile: 'text-[#4fc3f7]',
  ok: 'text-[#7bd88f]',
  warn: 'text-[#ff9f43]',
  error: 'text-[#ff5a3c]',
};

const LEVEL_TAG: Record<LogLevel, string> = { info: 'info', phase: 'fase', tile: 'tile', ok: 'ok', warn: 'warn', error: 'galat' };

/**
 * The process log, in front of the map: every phase the Valhalla WASM worker reports, every graph
 * tile it reads, and the measurements the SDK returns with a route. Tile lines can be hidden, since a
 * cold route reads dozens of them.
 */
export function ProcessLog({ className = '' }: { className?: string }) {
  const entries = useProcessLog(state => state.entries);
  const open = useProcessLog(state => state.open);
  const running = useProcessLog(state => state.run !== null);
  const [showTiles, setShowTiles] = useState(true);
  const [follow, setFollow] = useState(true);
  const list = useRef<HTMLOListElement>(null);
  const visible = showTiles ? entries : entries.filter(entry => entry.level !== 'tile');

  useEffect(() => {
    if (follow && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [visible.length, follow, open]);

  return (
    <section data-testid="process-log" className={`nb-panel nb-log flex min-h-0 flex-col text-xs ${className}`}>
      <header className="flex items-center gap-2 border-b-3 border-nb-black px-2 py-1.5">
        <span className={`nb-dot ${running ? 'is-live' : ''}`} aria-hidden="true" />
        <h2 className="nb-title flex-1 text-xs">Log proses · Valhalla WASM</h2>
        <span className="font-mono opacity-60">{entries.length}</span>
        <button
          type="button"
          data-testid="toggle-log"
          aria-expanded={open}
          className="nb-button px-2 py-0.5 text-xs"
          onClick={() => useProcessLog.getState().setOpen(!open)}
        >
          {open ? 'Ciutkan' : 'Buka'}
        </button>
      </header>
      {open ? (
        <>
          <ol
            ref={list}
            data-testid="log-entries"
            onScroll={event => {
              const element = event.currentTarget;
              setFollow(element.scrollHeight - element.scrollTop - element.clientHeight < 24);
            }}
            className="nb-terminal min-h-24 flex-1 overflow-y-auto px-2 py-1.5 font-mono leading-snug"
          >
            {visible.length === 0 ? (
              <li className="text-[#cfd8dc] opacity-70">
                Belum ada proses. Klik peta untuk menaruh dua titik lalu “Hitung rute”: runtime WASM, indeks graf dan tile yang
                diunduh akan tercatat di sini.
              </li>
            ) : visible.map(entry => (
              <li key={entry.id} className={`${LEVEL_CLASS[entry.level]} nb-log-line`}>
                <span className="opacity-50">
                  {new Date(entry.at).toLocaleTimeString('id-ID', { hour12: false })}
                  {entry.sinceRun === null ? '' : ` +${(entry.sinceRun / 1000).toFixed(2)}s`}
                </span>{' '}
                <span className="font-bold uppercase">{LEVEL_TAG[entry.level]}</span> {entry.text}
              </li>
            ))}
          </ol>
          <footer className="flex flex-wrap items-center gap-2 border-t-3 border-nb-black px-2 py-1.5">
            <label className="flex items-center gap-1">
              <input type="checkbox" className="accent-nb-terracotta" checked={showTiles} onChange={event => setShowTiles(event.target.checked)} />
              Baris tile
            </label>
            {!follow ? (
              <button type="button" className="nb-button px-2 py-0.5 text-xs" onClick={() => setFollow(true)}>↓ Terbaru</button>
            ) : null}
            <span className="flex-1" />
            <button
              type="button"
              className="nb-button px-2 py-0.5 text-xs"
              disabled={entries.length === 0}
              onClick={() => void copyText(entries.map(formatEntry).join('\n'), 'Log')}
            >
              Salin
            </button>
            <button
              type="button"
              className="nb-button px-2 py-0.5 text-xs"
              disabled={entries.length === 0 || running}
              onClick={() => useProcessLog.getState().clear()}
            >
              Bersihkan
            </button>
          </footer>
        </>
      ) : null}
    </section>
  );
}
