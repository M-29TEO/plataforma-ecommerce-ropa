'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { errorMessage } from '@/lib/api/client';

type Kind = 'ok' | 'error' | 'info';
interface Toast {
  id: number;
  kind: Kind;
  text: string;
}

interface ToastApi {
  ok(text: string): void;
  info(text: string): void;
  /** Acepta un texto o un error (usa el mensaje del API). */
  error(textOrError: unknown): void;
}

const ToastContext = createContext<ToastApi | null>(null);

const STYLES: Record<Kind, string> = {
  ok: 'border-ok/30 bg-ok text-white',
  error: 'border-danger/30 bg-danger text-white',
  info: 'border-line bg-ink text-paper',
};

/** Avisos breves abajo a la derecha (role=status: los lectores de pantalla los anuncian). */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const push = useCallback((kind: Kind, text: string) => {
    if (!text) return;
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      ok: (text) => push('ok', text),
      info: (text) => push('info', text),
      error: (e) => push('error', typeof e === 'string' ? e : errorMessage(e)),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`pointer-events-auto rounded-lg border px-4 py-3 text-sm shadow-lg ${STYLES[t.kind]}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast fuera de <ToastProvider>');
  return ctx;
}
