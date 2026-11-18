/** Emisor mínimo para avisar a las pantallas desde la tarea de GPS y el cliente de ntfy. */
export class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  on(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(value: T): void {
    for (const l of [...this.listeners]) {
      try {
        l(value);
      } catch {
        // Un listener roto no corta a los demás.
      }
    }
  }
}

export interface GpsStatus {
  lastFix: { lat: number; lng: number; timestamp: number } | null;
  lastSentAt: number | null;
  pending: number;
  error: string | null;
}

export const gpsEvents = new Emitter<GpsStatus>();
/** Hay ofertas abiertas (por ntfy o por la respuesta del GPS): la pantalla vuelve a pedirlas. */
export const offerEvents = new Emitter<{ source: 'ntfy' | 'gps' | 'push' }>();
