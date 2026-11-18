'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface PwaContextValue {
  /** Chrome/Edge/Android: se puede mostrar el diálogo de instalación. */
  canInstall: boolean;
  install(): Promise<void>;
  /** iOS Safari no tiene diálogo: se explica "Compartir → Agregar a inicio". */
  isIos: boolean;
  installed: boolean;
}

const PwaContext = createContext<PwaContextValue>({ canInstall: false, install: async () => undefined, isIos: false, installed: false });

/** Registra el service worker (/sw.js) y captura el evento de instalación de la PWA. */
export function PwaProvider({ children }: { children: React.ReactNode }) {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [isIos, setIsIos] = useState(false);

  useEffect(() => {
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
      navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => undefined);
    }
    setInstalled(window.matchMedia('(display-mode: standalone)').matches);
    setIsIos(/iPad|iPhone|iPod/.test(navigator.userAgent) && !('MSStream' in window));
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const value = useMemo<PwaContextValue>(
    () => ({
      canInstall: !!deferred && !installed,
      isIos,
      installed,
      async install() {
        if (!deferred) return;
        await deferred.prompt();
        await deferred.userChoice;
        setDeferred(null);
      },
    }),
    [deferred, installed, isIos],
  );
  return <PwaContext.Provider value={value}>{children}</PwaContext.Provider>;
}

export const usePwa = () => useContext(PwaContext);
