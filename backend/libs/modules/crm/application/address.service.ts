import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Database } from '../../../shared-kernel';
import {
  AddressFields,
  AddressProps,
  assertPinInEcuador,
  GeocodeAccuracy,
  GeoPoint,
  locationFieldsChanged,
  locationStatus,
  MAX_ADDRESSES_PER_USER,
  normalizeAddressFields,
} from '../domain/address';
import { AddressLimitError, AddressNotFoundError } from '../domain/errors';
import { buildGeocodeAttempts, GeocodeQuery, pickCandidate } from '../domain/geocoding';
import { AddressRepository, GeocoderPort, GeocoderUnavailableError } from './ports';

export type AddressInput = Partial<Record<keyof AddressFields, string | null>>;

/**
 * Resultado de la geocodificación de esta petición:
 *  - found: Nominatim ubicó la dirección (ver accuracy);
 *  - not_found / unavailable / disabled: no hay ubicación; el cliente debe marcar el pin;
 *  - pin: el cliente marcó el punto (no se geocodificó);
 *  - kept: no cambió nada que afecte la ubicación.
 */
export type GeocodeStatus = 'found' | 'not_found' | 'unavailable' | 'disabled' | 'pin' | 'kept';

export type AddressView = Omit<AddressProps, 'tenantId' | 'userId'> & { needsPin: boolean; pinRecommended: boolean };

export interface AddressResult {
  address: AddressView;
  geocode: { status: GeocodeStatus; displayName?: string };
}

export interface GeocodePreview {
  status: Exclude<GeocodeStatus, 'pin' | 'kept'>;
  candidates: Array<{ lat: number; lng: number; accuracy: GeocodeAccuracy; displayName: string }>;
}

interface Located {
  status: GeocodeStatus;
  location: GeoPoint | null;
  accuracy: GeocodeAccuracy | null;
  displayName?: string;
}

const MAX_PREVIEW_CANDIDATES = 5;

export function addressView(a: AddressProps): AddressView {
  const { tenantId: _t, userId: _u, ...rest } = a;
  return { ...rest, ...locationStatus(a) };
}

/**
 * Libreta de direcciones del cliente. La ubicación sale de Nominatim (consultas en cascada) o de un
 * pin que marca el cliente en el mapa; si Nominatim no la encuentra o no responde, la dirección se
 * guarda igual y queda needsPin (no se puede cotizar el envío hasta marcarla).
 * La geocodificación corre FUERA de la transacción: es una llamada HTTP de hasta NOMINATIM_TIMEOUT_MS.
 */
@Injectable()
export class AddressService {
  private readonly logger = new Logger(AddressService.name);

  constructor(
    private readonly db: Database,
    private readonly addresses: AddressRepository,
    private readonly geocoder: GeocoderPort,
  ) {}

  list(tenantId: string, userId: string): Promise<AddressView[]> {
    return this.addresses.list(this.db, tenantId, userId).then((rows) => rows.map(addressView));
  }

  async get(tenantId: string, userId: string, id: string): Promise<AddressProps> {
    const a = await this.addresses.findById(this.db, tenantId, userId, id);
    if (!a) throw new AddressNotFoundError(id);
    return a;
  }

  async create(tenantId: string, userId: string, input: AddressInput & { pin?: GeoPoint | null; isDefault?: boolean }): Promise<AddressResult> {
    const fields = normalizeAddressFields(input);
    const located = input.pin ? this.pinned(input.pin) : await this.geocode(fields);
    return this.db.withTransaction(async (tx) => {
      await this.addresses.lockOwner(tx, tenantId, userId);
      const count = await this.addresses.count(tx, tenantId, userId);
      if (count >= MAX_ADDRESSES_PER_USER) throw new AddressLimitError(MAX_ADDRESSES_PER_USER);
      const isDefault = input.isDefault === true || count === 0;
      if (isDefault) await this.addresses.clearDefault(tx, tenantId, userId);
      const address: AddressProps = {
        ...fields,
        id: randomUUID(),
        tenantId,
        userId,
        location: located.location,
        geocodeAccuracy: located.accuracy,
        isDefault,
        createdAt: new Date(),
      };
      await this.addresses.insert(tx, address);
      return { address: addressView(address), geocode: this.geocodeInfo(located) };
    });
  }

  /**
   * Cambia campos (los ausentes se conservan; null borra un opcional). Si cambia algo que mueve la
   * ubicación (calle, número, barrio, ciudad...) se vuelve a geocodificar, salvo que llegue un pin.
   */
  async update(tenantId: string, userId: string, id: string, input: AddressInput & { pin?: GeoPoint | null }): Promise<AddressResult> {
    const current = await this.get(tenantId, userId, id);
    const merged = { ...pickFields(current), ...definedOnly(input) };
    const fields = normalizeAddressFields(merged);
    let located: Located;
    if (input.pin) located = this.pinned(input.pin);
    else if (locationFieldsChanged(pickFields(current), fields)) located = await this.geocode(fields);
    else located = { status: 'kept', location: current.location, accuracy: current.geocodeAccuracy };

    return this.db.withTransaction(async (tx) => {
      await this.addresses.lockOwner(tx, tenantId, userId);
      const fresh = await this.addresses.findById(tx, tenantId, userId, id);
      if (!fresh) throw new AddressNotFoundError(id);
      const updated: AddressProps = { ...fresh, ...fields, location: located.location, geocodeAccuracy: located.accuracy };
      await this.addresses.update(tx, updated);
      return { address: addressView(updated), geocode: this.geocodeInfo(located) };
    });
  }

  /** Pin manual: el cliente marca el punto exacto en el mapa (precisión user_pin). */
  async setLocation(tenantId: string, userId: string, id: string, pin: GeoPoint): Promise<AddressView> {
    const point = assertPinInEcuador(pin);
    return this.db.withTransaction(async (tx) => {
      const current = await this.addresses.findById(tx, tenantId, userId, id);
      if (!current) throw new AddressNotFoundError(id);
      const updated: AddressProps = { ...current, location: point, geocodeAccuracy: 'user_pin' };
      await this.addresses.update(tx, updated);
      return addressView(updated);
    });
  }

  async setDefault(tenantId: string, userId: string, id: string): Promise<AddressView> {
    return this.db.withTransaction(async (tx) => {
      await this.addresses.lockOwner(tx, tenantId, userId);
      const current = await this.addresses.findById(tx, tenantId, userId, id);
      if (!current) throw new AddressNotFoundError(id);
      if (!current.isDefault) {
        await this.addresses.clearDefault(tx, tenantId, userId);
        current.isDefault = true;
        await this.addresses.update(tx, current);
      }
      return addressView(current);
    });
  }

  /** Si era la predeterminada, pasa a serlo la más reciente de las que quedan. */
  async delete(tenantId: string, userId: string, id: string): Promise<void> {
    await this.db.withTransaction(async (tx) => {
      await this.addresses.lockOwner(tx, tenantId, userId);
      const current = await this.addresses.findById(tx, tenantId, userId, id);
      if (!current) throw new AddressNotFoundError(id);
      await this.addresses.delete(tx, tenantId, userId, id);
      if (current.isDefault) await this.addresses.promoteLatestAsDefault(tx, tenantId, userId);
    });
  }

  /**
   * Vista previa para el mapa (antes de guardar): candidatos del primer intento de la cascada que
   * encuentre algo creíble. El storefront centra el mapa en el primero y el cliente ajusta el pin.
   */
  async preview(input: AddressInput): Promise<GeocodePreview> {
    // Para ubicar no hacen falta destinatario ni teléfono: se completan con relleno.
    const fields = normalizeAddressFields({ recipientName: '--', recipientPhone: '0000000', ...definedOnly(input) });
    if (!this.geocoder.enabled) return { status: 'disabled', candidates: [] };
    try {
      for (const attempt of buildGeocodeAttempts(fields)) {
        const found = await this.geocoder.search(attempt);
        const candidates = found
          .map((c) => pickCandidate([c], fields, attempt))
          .filter((c): c is NonNullable<typeof c> => c !== null)
          .slice(0, MAX_PREVIEW_CANDIDATES)
          .map((c) => ({ ...c.point, accuracy: c.accuracy, displayName: c.displayName }));
        if (candidates.length > 0) return { status: 'found', candidates };
      }
      return { status: 'not_found', candidates: [] };
    } catch (e) {
      if (e instanceof GeocoderUnavailableError) return { status: 'unavailable', candidates: [] };
      throw e;
    }
  }

  private pinned(pin: GeoPoint): Located {
    return { status: 'pin', location: assertPinInEcuador(pin), accuracy: 'user_pin' };
  }

  private async geocode(q: GeocodeQuery): Promise<Located> {
    if (!this.geocoder.enabled) return { status: 'disabled', location: null, accuracy: null };
    try {
      for (const attempt of buildGeocodeAttempts(q)) {
        const picked = pickCandidate(await this.geocoder.search(attempt), q, attempt);
        if (picked) return { status: 'found', location: picked.point, accuracy: picked.accuracy, displayName: picked.displayName };
      }
      return { status: 'not_found', location: null, accuracy: null };
    } catch (e) {
      if (!(e instanceof GeocoderUnavailableError)) throw e;
      this.logger.warn(`Nominatim no disponible (${e.message}); la dirección queda sin ubicación`);
      return { status: 'unavailable', location: null, accuracy: null };
    }
  }

  private geocodeInfo(l: Located): AddressResult['geocode'] {
    return l.displayName ? { status: l.status, displayName: l.displayName } : { status: l.status };
  }
}

const FIELD_KEYS: ReadonlyArray<keyof AddressFields> = [
  'label',
  'recipientName',
  'recipientPhone',
  'province',
  'city',
  'parish',
  'neighborhood',
  'mainStreet',
  'crossStreet',
  'houseNumber',
  'reference',
];

function pickFields(a: AddressFields): AddressFields {
  const out = {} as Record<keyof AddressFields, string | null>;
  for (const k of FIELD_KEYS) out[k] = a[k];
  return out as unknown as AddressFields;
}

function definedOnly(input: AddressInput): AddressInput {
  const out: AddressInput = {};
  for (const k of FIELD_KEYS) if (input[k] !== undefined) out[k] = input[k];
  return out;
}
