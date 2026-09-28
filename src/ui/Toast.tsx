import { useEffect } from 'react';
import { create } from 'zustand';

interface ToastState {
  message: string | null;
  tone: 'ok' | 'error';
  nonce: number;
  show(message: string, tone?: 'ok' | 'error'): void;
  dismiss(): void;
}

/** One toast at a time: a newer message replaces the one on screen. */
export const useToast = create<ToastState>((set, get) => ({
  message: null,
  tone: 'ok',
  nonce: 0,
  show(message, tone = 'ok') { set({ message, tone, nonce: get().nonce + 1 }); },
  dismiss() { set({ message: null }); },
}));

/** Copy text and say whether it worked; `execCommand` covers browsers without the async API. */
export async function copyText(text: string, what: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      if (!ok) throw new Error('copy refused');
    }
    useToast.getState().show(`${what} disalin ke clipboard.`);
  } catch {
    useToast.getState().show(`${what} gagal disalin — izin clipboard ditolak browser.`, 'error');
  }
}

export function Toast() {
  const message = useToast(state => state.message);
  const tone = useToast(state => state.tone);
  const nonce = useToast(state => state.nonce);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => useToast.getState().dismiss(), 2800);
    return () => clearTimeout(timer);
  }, [message, nonce]);
  if (!message) return null;
  return (
    <div
      key={nonce}
      role="status"
      data-testid="toast"
      className={`nb-panel nb-toast absolute left-1/2 top-3 z-50 -translate-x-1/2 px-3 py-2 text-sm font-bold ${tone === 'error' ? 'bg-nb-terracotta text-nb-cream' : ''}`}
    >
      {message}
    </div>
  );
}
