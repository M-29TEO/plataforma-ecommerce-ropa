import { MapsPort, Route } from '../../application/ports';
import { GeoPoint } from '../../domain/geo';

/**
 * MapsPort → OSRM (perfil car sobre el extracto de Ecuador de OpenStreetMap):
 *   GET /route/v1/driving/{lng,lat};{lng,lat}?overview=false
 * Distancia real por calle y duración. Si OSRM no está levantado (perfil maps de docker compose)
 * o tarda más de OSRM_TIMEOUT_MS, lanza y RiderDistance usa la línea recta.
 */
export class OsrmMapsAdapter extends MapsPort {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {
    super();
  }

  async route(from: GeoPoint, to: GeoPoint): Promise<Route> {
    const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;
    const res = await fetch(`${this.baseUrl}/route/v1/driving/${coords}?overview=false&alternatives=false&steps=false`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`OSRM respondió HTTP ${res.status}`);
    const body = (await res.json()) as { code?: string; routes?: { distance: number; duration: number }[] };
    const best = body.routes?.[0];
    if (body.code !== 'Ok' || !best) throw new Error(`OSRM sin ruta (${body.code ?? 'sin código'})`);
    return { distanceM: Math.round(best.distance), durationS: Math.round(best.duration) };
  }
}

/** OSRM_URL vacío: no hay servicio de rutas (siempre se usa la distancia en línea recta). */
export class NoMapsAdapter extends MapsPort {
  route(): Promise<Route> {
    return Promise.reject(new Error('OSRM no configurado (OSRM_URL vacío)'));
  }
}
