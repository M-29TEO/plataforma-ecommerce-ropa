'use client';

import { useState } from 'react';
import { usePwa } from './PwaProvider';

/** "Instalar la app": diálogo nativo en Chrome/Edge/Android; instrucciones en iOS. */
export function InstallAppButton() {
  const { canInstall, install, isIos, installed } = usePwa();
  const [showIosHelp, setShowIosHelp] = useState(false);
  if (installed) return null;
  if (canInstall) {
    return (
      <button type="button" className="btn-ghost" onClick={() => void install()}>
        Instalar la app
      </button>
    );
  }
  if (isIos) {
    return (
      <div>
        <button type="button" className="btn-ghost" onClick={() => setShowIosHelp((v) => !v)}>
          Instalar en iPhone
        </button>
        {showIosHelp && <p className="mt-2 text-xs text-ink-soft">Toca Compartir y luego «Agregar a pantalla de inicio».</p>}
      </div>
    );
  }
  return null;
}
