import { create } from 'zustand';
import type { ProgressEvent as SdkProgress } from 'valhalla-browser';

/**
 * The process log: what the Valhalla WASM worker and the app did, in order, with timestamps.
 *
 * Every line is either an SDK progress event (the worker's own phase and tile notifications) or a
 * measurement the SDK returned; the log states nothing the run did not report. Tile fetches are the
 * noisy part — a cold Jakarta → Bandung route reads dozens — so the list is capped, and the loader
 * reads its counters from here rather than keeping its own.
 */

export type LogLevel = 'info' | 'phase' | 'tile' | 'ok' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  /** Host wall clock, epoch milliseconds. */
  at: number;
  /** Milliseconds since the current run started; null outside a run. */
  sinceRun: number | null;
  level: LogLevel;
  text: string;
}

/** What the loader shows for the run in progress. */
export interface RunProgress {
  startedAt: number;
  /** Phases seen in this run, with the moment each was first seen. */
  phases: Partial<Record<SdkProgress['phase'], number>>;
  current: SdkProgress['phase'] | null;
  tiles: number;
  lastTile: string | null;
}

export interface ProcessLogState {
  entries: LogEntry[];
  run: RunProgress | null;
  /** Whether the log panel is open; kept here so the loader can open it. */
  open: boolean;
  push(level: LogLevel, text: string): void;
  beginRun(): void;
  progress(event: SdkProgress): void;
  endRun(): void;
  clear(): void;
  setOpen(open: boolean): void;
}

/** Enough for a cold multi-stop route; older lines scroll off. */
export const MAX_ENTRIES = 600;

const PHASE_TEXT: Record<SdkProgress['phase'], string> = {
  'loading-runtime': 'Memuat & mengompilasi runtime Valhalla WASM',
  'initializing-graph': 'Membaca header/indeks arsip graf',
  'fetching-tile': 'Mengunduh tile graf',
  routing: 'Native vb_route: mencari jalur di graf',
};

let nextId = 1;

export const useProcessLog = create<ProcessLogState>((set, get) => ({
  entries: [],
  run: null,
  // In front on a desktop; on a phone the map needs the room, so the log starts behind a button.
  open: typeof matchMedia === 'function' ? matchMedia('(min-width: 768px)').matches : true,

  push(level, text) {
    const run = get().run;
    const at = Date.now();
    const entry: LogEntry = { id: nextId++, at, sinceRun: run ? at - run.startedAt : null, level, text };
    const entries = get().entries;
    set({ entries: entries.length >= MAX_ENTRIES ? [...entries.slice(entries.length - MAX_ENTRIES + 1), entry] : [...entries, entry] });
  },
  beginRun() {
    set({ run: { startedAt: Date.now(), phases: {}, current: null, tiles: 0, lastTile: null } });
  },
  progress(event) {
    const run = get().run;
    if (!run) return;
    const firstOfPhase = run.phases[event.phase] === undefined;
    const tile = event.phase === 'fetching-tile';
    set({
      run: {
        ...run,
        phases: firstOfPhase ? { ...run.phases, [event.phase]: Date.now() } : run.phases,
        current: event.phase,
        tiles: run.tiles + (tile ? 1 : 0),
        lastTile: tile ? event.tileId ?? run.lastTile : run.lastTile,
      },
    });
    if (tile) get().push('tile', `↓ tile ${event.tileId ?? '?'} (#${run.tiles + 1})`);
    else if (event.phase === 'initializing-graph' && !firstOfPhase) return;
    else get().push('phase', PHASE_TEXT[event.phase]);
  },
  endRun() {
    set({ run: null });
  },
  clear() {
    set({ entries: [] });
  },
  setOpen(open) {
    set({ open });
  },
}));

/** One log line as plain text, for "copy log". */
export function formatEntry(entry: LogEntry): string {
  const clock = new Date(entry.at).toLocaleTimeString('id-ID', { hour12: false });
  const since = entry.sinceRun === null ? '' : ` +${(entry.sinceRun / 1000).toFixed(2)}s`;
  return `[${clock}${since}] ${entry.level.toUpperCase().padEnd(5)} ${entry.text}`;
}
