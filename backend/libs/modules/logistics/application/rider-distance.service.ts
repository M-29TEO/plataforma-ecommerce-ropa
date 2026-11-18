import { Injectable, Logger } from '@nestjs/common';
import { estimatedRoadMeters, GeoPoint } from '../domain/geo';
import { MapsPort } from './ports';

export type DistanceSource = 'osrm' | 'straight_line';

export interface RiderDistance {
  distanceM: number;
  source: DistanceSource;
  durationS: number | null;
}

const WARN_EVERY_MS = 60_000;

/**
 * Distancia de la bodega al cliente para la tarifa del motorizado: la ruta real por calle
 * (MapsPort → OSRM) y, si OSRM no está levantado o falla, la línea recta × 1,3. La cotización
 * nunca falla por el servicio de mapas: solo pierde precisión, y la respuesta dice cuál se usó.
 */
@Injectable()
export class RiderDistanceService {
  private readonly logger = new Logger(RiderDistanceService.name);
  private lastWarnAt = 0;

  constructor(private readonly maps: MapsPort) {}

  async between(from: GeoPoint, to: GeoPoint): Promise<RiderDistance> {
    try {
      const route = await this.maps.route(from, to);
      return { distanceM: route.distanceM, source: 'osrm', durationS: route.durationS };
    } catch (error) {
      // Sin OSRM cada cotización fallaría igual: un aviso por minuto basta.
      if (Date.now() - this.lastWarnAt > WARN_EVERY_MS) {
        this.lastWarnAt = Date.now();
        this.logger.warn(`OSRM no disponible (${(error as Error).message}); se usa la distancia en línea recta`);
      }
      return { distanceM: estimatedRoadMeters(from, to), source: 'straight_line', durationS: null };
    }
  }
}
