import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { errorMessage } from './api-client';
import { gpsEvents, GpsStatus, offerEvents } from './events';
import { gpsStatus } from './location-task';
import type { Offer, RiderShipment } from './types';

export interface Resource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload(): Promise<void>;
}

/**
 * Carga al enfocar la pantalla y, si se indica, cada `pollMs` mientras está enfocada. Si cambia
 * `key` (p. ej. el período elegido), se vuelve a cargar.
 */
export function useResource<T>(load: () => Promise<T>, opts: { pollMs?: number; enabled?: boolean; key?: string } = {}): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  // La última versión de `load` se guarda tras el render (React no permite escribir refs durante el render).
  useEffect(() => {
    loadRef.current = load;
  });
  const enabled = opts.enabled ?? true;

  const reload = useCallback(async () => {
    try {
      setData(await loadRef.current());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (!enabled) {
        setLoading(false);
        return;
      }
      void reload();
      if (!opts.pollMs) return;
      const t = setInterval(() => void reload(), opts.pollMs);
      return () => clearInterval(t);
    }, [enabled, reload, opts.pollMs, opts.key]),
  );

  return { data, error, loading, reload };
}

/** Ofertas abiertas: se recargan al llegar un aviso (ntfy o GPS) y cada 20 s como red de seguridad. */
export function useOffers(enabled: boolean): Resource<Offer[]> {
  const res = useResource(() => api.offers(), { pollMs: 20_000, enabled });
  const { reload } = res;
  useEffect(() => (enabled ? offerEvents.on(() => void reload()) : undefined), [enabled, reload]);
  return res;
}

export function useActiveShipments(enabled = true): Resource<RiderShipment[]> {
  return useResource(() => api.shipments(), { pollMs: 30_000, enabled });
}

/** Re-render cada segundo (cuentas regresivas de ofertas, duración del turno). */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function useGpsStatus(): GpsStatus {
  const [status, setStatus] = useState<GpsStatus>(gpsStatus());
  useEffect(() => gpsEvents.on(setStatus), []);
  return status;
}
