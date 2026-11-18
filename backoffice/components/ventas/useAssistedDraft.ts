'use client';

import { useCallback, useEffect, useState } from 'react';
import { DRAFT_STORAGE_KEY, emptyDraft, parseDraft, type AssistedDraft } from '@/lib/assisted';

export type DraftPatch = Partial<AssistedDraft> | ((d: AssistedDraft) => Partial<AssistedDraft>);

/**
 * Estado del asistente de pedido asistido, guardado en sessionStorage para que una recarga no lo
 * pierda. Se lee después de montar (en el servidor no hay sessionStorage) y todo acceso va en
 * try/catch: en modo privado o con el almacenamiento bloqueado el asistente funciona igual.
 */
export function useAssistedDraft() {
  const [draft, setDraft] = useState<AssistedDraft>(emptyDraft);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    let saved: AssistedDraft | null = null;
    try {
      saved = parseDraft(sessionStorage.getItem(DRAFT_STORAGE_KEY));
    } catch {
      saved = null;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- restaurar el borrador al montar (no existe en el servidor)
    if (saved) setDraft(saved);
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored) return;
    try {
      sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
    } catch {
      // Sin almacenamiento: el borrador vive solo en memoria.
    }
  }, [draft, restored]);

  const update = useCallback((patch: DraftPatch) => {
    setDraft((d) => ({ ...d, ...(typeof patch === 'function' ? patch(d) : patch) }));
  }, []);

  const reset = useCallback(() => {
    try {
      sessionStorage.removeItem(DRAFT_STORAGE_KEY);
    } catch {
      // Nada que borrar.
    }
    setDraft(emptyDraft());
  }, []);

  return { draft, update, reset, restored };
}
