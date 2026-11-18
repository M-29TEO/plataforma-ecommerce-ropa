import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../../../shared-kernel';
import { GeocodeAttempt, GeocodeCandidate } from '../../domain/geocoding';
import { GeocoderPort, GeocoderUnavailableError } from '../../application/ports';

/** Lo que usamos de un resultado de /search?format=jsonv2&addressdetails=1. */
export interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
  category?: string;
  type?: string;
  addresstype?: string;
  address?: Record<string, string | undefined>;
}

const MAX_RESULTS = 5;

/** Traduce un resultado de Nominatim al candidato del dominio. */
export function toCandidate(r: NominatimResult): GeocodeCandidate | null {
  const lat = Number(r.lat);
  const lng = Number(r.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const a = r.address ?? {};
  const kind: GeocodeCandidate['kind'] =
    a.house_number || r.addresstype === 'house' || r.type === 'house'
      ? 'house'
      : r.category === 'highway' || r.addresstype === 'road'
        ? 'street'
        : 'area';
  return {
    lat,
    lng,
    kind,
    displayName: r.display_name,
    city: a.city ?? a.town ?? a.village ?? a.municipality ?? a.county ?? null,
    province: a.state ?? null,
    neighborhood: a.neighbourhood ?? a.suburb ?? a.quarter ?? null,
  };
}

/**
 * GeocoderPort con Nominatim propio (perfil maps de docker-compose, datos OSM de Ecuador). Solo
 * Ecuador (countrycodes=ec), resultados en español y timeout corto: si no responde, la dirección se
 * guarda sin ubicación y el cliente marca el pin. Envía User-Agent como pide la política de uso
 * (obligatorio si alguien apunta NOMINATIM_URL al servidor público).
 */
@Injectable()
export class NominatimGeocoder extends GeocoderPort {
  readonly enabled: boolean;
  private readonly baseUrl: string | null;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super();
    this.baseUrl = config.crm.nominatimUrl;
    this.enabled = this.baseUrl !== null;
    this.timeoutMs = config.crm.nominatimTimeoutMs;
    this.userAgent = config.crm.nominatimUserAgent;
  }

  async search(attempt: GeocodeAttempt): Promise<GeocodeCandidate[]> {
    if (!this.baseUrl) return [];
    const params = new URLSearchParams({ format: 'jsonv2', addressdetails: '1', countrycodes: 'ec', limit: String(MAX_RESULTS), 'accept-language': 'es' });
    if (attempt.type === 'structured') {
      params.set('street', attempt.street);
      params.set('city', attempt.city);
      params.set('state', attempt.state);
      params.set('country', 'Ecuador');
    } else {
      params.set('q', attempt.q);
    }
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/search?${params}`, {
        headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      // Bajo Jest el DOMException del abort no es instanceof Error: se mira el nombre.
      const name = (e as { name?: string })?.name;
      throw new GeocoderUnavailableError(name === 'TimeoutError' || name === 'AbortError' ? `sin respuesta en ${this.timeoutMs} ms` : String((e as Error)?.message ?? e));
    }
    if (!response.ok) throw new GeocoderUnavailableError(`HTTP ${response.status}`);
    const body = (await response.json().catch(() => null)) as unknown;
    if (!Array.isArray(body)) throw new GeocoderUnavailableError('respuesta inesperada');
    return body.map((r) => toCandidate(r as NominatimResult)).filter((c): c is GeocodeCandidate => c !== null);
  }
}
