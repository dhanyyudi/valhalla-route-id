import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { useProcessLog } from '../state/process-log';
import { useScenario } from '../state/scenario';
import { formatBytes } from './format';

/**
 * "What is Valhalla WASM?" — why the first route takes a while and what happens meanwhile.
 *
 * The figures quoted are this deployment's own measurements (README, `src/router/client.ts` and the
 * acceptance runs): a ~9.6 MiB engine, Jakarta tiles up to 46 MiB, roughly 200 MB of graph for
 * Jakarta → Bandung, and a 384 MiB tile cache. The live section reads the current session instead of
 * quoting anything.
 */

const SEEN_KEY = 'valhalla-route-id:explainer-seen';

interface ExplainerState {
  open: boolean;
  setOpen(open: boolean): void;
}

export const useExplainer = create<ExplainerState>(set => ({
  open: false,
  setOpen(open) {
    set({ open });
    if (open) markSeen();
  },
}));

function markSeen(): void {
  try { globalThis.localStorage?.setItem(SEEN_KEY, '1'); } catch { /* storage may be blocked */ }
}

function seenBefore(): boolean {
  try { return globalThis.localStorage?.getItem(SEEN_KEY) === '1'; } catch { return true; }
}

const STEPS: Array<{ title: string; body: string }> = [
  {
    title: 'Mesin WASM dimuat',
    body: 'Browser mengunduh mesin Valhalla (±9,6 MB, ±2,2 MB terkompresi) dan mengompilasinya di Web Worker. Sekali per sesi.',
  },
  {
    title: 'Indeks graf dibaca',
    body: 'Header dan indeks arsip graf Indonesia dibaca, supaya mesin tahu di byte mana setiap tile berada. Belum ada jalan yang diunduh.',
  },
  {
    title: 'Pencarian rute + unduh tile',
    body: 'A* mencari jalur. Setiap kali pencarian masuk ke area baru, tile graf area itu diunduh saat itu juga — satu tile Jakarta bisa ±46 MB.',
  },
  {
    title: 'Hasil & cache',
    body: 'Tile yang sudah di-decode disimpan di memori (hingga 384 MB). Rute berikutnya di area yang sama biasanya selesai dalam hitungan detik.',
  },
];

/** The full explanation, as a dialog. */
export function WasmExplainer() {
  const open = useExplainer(state => state.open);
  const session = useProcessLog(state => state.session);
  const status = useScenario(state => state.status);
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') useExplainer.getState().setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return <WelcomeCard />;
  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 p-3"
      onClick={event => { if (event.target === event.currentTarget) useExplainer.getState().setOpen(false); }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="explainer-title"
        data-testid="wasm-explainer"
        className="nb-panel nb-loader max-h-[calc(100dvh-1.5rem)] w-[min(40rem,100%)] overflow-y-auto p-4 text-sm"
      >
        <header className="flex items-start gap-3">
          <div className="flex-1">
            <h2 id="explainer-title" className="nb-title text-lg">Apa itu Valhalla WASM?</h2>
            <p className="mt-1">
              <strong>Valhalla</strong> adalah mesin rute open-source (C++) yang biasanya berjalan di server. Di sini ia
              dikompilasi ke <strong>WebAssembly</strong> dan berjalan <strong>di browser Anda sendiri</strong>, di Web Worker —
              tidak ada server rute. Server hanya mengirim potongan data graf jalan; koordinat titik Anda tidak dikirim ke mana pun.
            </p>
          </div>
          <button ref={close} type="button" data-testid="close-explainer" className="nb-button px-2 py-1 text-xs" onClick={() => useExplainer.getState().setOpen(false)}>
            Tutup
          </button>
        </header>

        <h3 className="nb-title mt-4 text-sm">Kenapa rute pertama lama?</h3>
        <p className="mt-1">
          Semua yang biasanya sudah ada di server harus tiba dulu di browser: mesinnya, lalu graf jalan untuk area yang dilewati.
          Rute Jakarta → Bandung membaca ±200 MB graf; di koneksi yang padat satu tile besar bisa butuh lebih dari semenit. Setelah
          itu datanya ada di memori, jadi rute berikutnya di area yang sama jauh lebih cepat.
        </p>

        <ol className="mt-3 grid gap-2 sm:grid-cols-2">
          {STEPS.map((step, index) => (
            <li key={step.title} className="nb-step" data-state="done">
              <span className="nb-step-icon" aria-hidden="true">{index + 1}</span>
              <span className="block font-bold">{step.title}</span>
              <span className="block text-xs opacity-80">{step.body}</span>
            </li>
          ))}
        </ol>

        <h3 className="nb-title mt-4 text-sm">Tips supaya cepat</h3>
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          <li>Biarkan tab tetap terbuka: cache tile hilang saat halaman dimuat ulang.</li>
          <li><strong>Batal</strong> menghentikan worker dan membuang cache-nya; rute berikutnya mengunduh ulang tile.</li>
          <li>Mobil dan Motor paling cepat. Sepeda dan Jalan kaki menjelajah jauh lebih banyak jalan dan bisa melewati batas waktu.</li>
          <li>Proses lengkapnya — setiap fase dan setiap tile — tercatat di <strong>Log proses</strong>.</li>
        </ul>

        <h3 className="nb-title mt-4 text-sm">Sesi ini</h3>
        <p data-testid="explainer-session" className="mt-1 font-mono text-xs">
          {status === 'routing'
            ? 'Mesin sedang bekerja — lihat kartu progres dan log proses.'
            : session.ready
              ? `Mesin siap · cache tile ${formatBytes(session.decodedCacheBytes)} · heap WASM puncak ${formatBytes(session.heapHighWaterBytes)}`
              : 'Mesin belum dimuat (atau dibuang setelah Batal): ia diunduh saat rute berikutnya dihitung.'}
        </p>
      </section>
    </div>
  );
}

/** A small, non-blocking hint on the first visit; it never covers the panel or the run button. */
function WelcomeCard() {
  const [visible, setVisible] = useState(() => !seenBefore());
  if (!visible) return null;
  const dismiss = () => { markSeen(); setVisible(false); };
  return (
    <aside
      data-testid="welcome-card"
      className="nb-panel nb-toast absolute bottom-20 left-1/2 z-30 w-[min(26rem,calc(100vw-1rem))] -translate-x-1/2 p-3 text-xs max-md:bottom-28"
    >
      <p className="nb-title text-sm">Rute dihitung di browser Anda</p>
      <p className="mt-1">
        Valhalla berjalan sebagai WebAssembly di perangkat ini. Rute pertama perlu mengunduh mesin dan graf jalan, jadi bisa
        makan waktu; rute berikutnya jauh lebih cepat.
      </p>
      <div className="mt-2 flex gap-2">
        <button type="button" data-testid="welcome-learn" className="nb-button flex-1 px-2 py-1 text-xs" onClick={() => { setVisible(false); useExplainer.getState().setOpen(true); }}>
          Pelajari cara kerjanya
        </button>
        <button type="button" data-testid="welcome-dismiss" className="nb-button px-2 py-1 text-xs" onClick={dismiss}>
          Mengerti
        </button>
      </div>
    </aside>
  );
}
