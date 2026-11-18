'use client';

import { useEffect, useState } from 'react';

/** Valor que cambia solo tras `ms` sin cambios (búsquedas mientras se escribe). */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Clave de idempotencia estable para un formulario (Idempotency-Key): la misma mientras no se
 * reinicie, así un doble clic o un reintento por red no crea dos pedidos.
 */
export function useIdempotencyKey(): [string, () => void] {
  const [key, setKey] = useState(() => crypto.randomUUID());
  return [key, () => setKey(crypto.randomUUID())];
}
