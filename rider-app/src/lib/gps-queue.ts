import { ApiError } from './api-client';
import { GPS_INTERVAL_MS, GPS_MAX_AGE_MS, GPS_QUEUE_MAX } from './config';

export interface Fix {
  lat: number;
  lng: number;
  heading?: number;
  speedKmh?: number;
  accuracyM?: number;
  /** ms desde epoch (hora del GPS). */
  timestamp: number;
}

/** Lo que entrega expo-location (LocationObject), reducido a lo que se usa. */
export interface RawLocation {
  timestamp: number;
  coords: { latitude: number; longitude: number; heading?: number | null; speed?: number | null; accuracy?: number | null };
}

export function toFix(l: RawLocation): Fix {
  const { heading, speed, accuracy } = l.coords;
  return {
    lat: l.coords.latitude,
    lng: l.coords.longitude,
    // heading < 0 = desconocido; la API acepta 0..359 y velocidades de 0..200 km/h.
    heading: heading !== null && heading !== undefined && heading >= 0 ? Math.round(heading) % 360 : undefined,
    speedKmh: speed !== null && speed !== undefined && speed >= 0 ? Math.min(200, Math.round(speed * 3.6 * 10) / 10) : undefined,
    accuracyM: accuracy !== null && accuracy !== undefined && accuracy >= 0 ? Math.min(5000, Math.round(accuracy)) : undefined,
    timestamp: l.timestamp,
  };
}

/**
 * Cola de posiciones del turno. Android entrega las posiciones en lotes (y más seguido de lo
 * pedido): se deja una cada ~10 s. Si no hay red, se guardan y se reenvían en orden al volver
 * (hasta 300 y menos de 55 min: la API rechaza posiciones de más de 1 hora).
 */
export class GpsQueue {
  private pending: Fix[] = [];
  private lastQueuedAt = -Infinity;
  private flushing: Promise<FlushResult> | null = null;

  constructor(
    private readonly send: (fix: Fix) => Promise<{ openOffers?: number } | void>,
    private readonly intervalMs = GPS_INTERVAL_MS,
  ) {}

  get size(): number {
    return this.pending.length;
  }

  /** Agrega las posiciones nuevas respetando el intervalo. Devuelve cuántas se encolaron. */
  add(fixes: Fix[]): number {
    let added = 0;
    for (const fix of [...fixes].sort((a, b) => a.timestamp - b.timestamp)) {
      // 10 % de tolerancia: el GPS no entrega exacto cada 10 000 ms.
      if (fix.timestamp - this.lastQueuedAt < this.intervalMs * 0.9) continue;
      this.pending.push(fix);
      this.lastQueuedAt = fix.timestamp;
      added++;
    }
    if (this.pending.length > GPS_QUEUE_MAX) this.pending.splice(0, this.pending.length - GPS_QUEUE_MAX);
    return added;
  }

  /** Envía en orden. Corta en el primer error de red (se reintenta con la próxima posición). */
  flush(now = Date.now()): Promise<FlushResult> {
    this.flushing ??= this.doFlush(now).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush(now: number): Promise<FlushResult> {
    const result: FlushResult = { sent: 0, dropped: 0, openOffers: null, sessionExpired: false };
    this.pending = this.pending.filter((f) => {
      const keep = now - f.timestamp <= GPS_MAX_AGE_MS;
      if (!keep) result.dropped++;
      return keep;
    });
    while (this.pending.length > 0) {
      const fix = this.pending[0];
      try {
        const ack = await this.send(fix);
        if (ack && typeof ack.openOffers === 'number') result.openOffers = ack.openOffers;
        result.sent++;
        this.pending.shift();
      } catch (error) {
        if (error instanceof ApiError) {
          if (error.status === 401 || error.status === 403) {
            result.sessionExpired = true;
            return result;
          }
          // 4xx: la API no la aceptará nunca (fuera de rango, inválida): se descarta.
          if (error.status >= 400 && error.status < 500 && error.status !== 429) {
            this.pending.shift();
            result.dropped++;
            continue;
          }
        }
        return result; // Red caída o 5xx/429: se reintenta luego.
      }
    }
    return result;
  }
}

export interface FlushResult {
  sent: number;
  dropped: number;
  openOffers: number | null;
  sessionExpired: boolean;
}
