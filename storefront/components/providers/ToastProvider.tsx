'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';

type Kind = 'ok' | 'error' | 'info';
interface Toast {
  id: number;
  kind: Kind;
  text: string;
}

const ToastContext = createContext<((text: string, kind?: Kind) => void) | null>(null);

let seq = 0;

/** Avisos breves (agregado al carrito, error de red). Región aria-live para lectores de pantalla. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Kind = 'info') => {
    if (!text) return;
    const id = ++seq;
    setToasts((t) => [...t.slice(-2), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            className={`pointer-events-auto max-w-md rounded-full px-4 py-2 text-sm shadow-lg ${
              t.kind === 'error' ? 'bg-danger text-white' : t.kind === 'ok' ? 'bg-ink text-paper' : 'bg-white text-ink'
            }`}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast fuera de <ToastProvider>');
  return ctx;
}
