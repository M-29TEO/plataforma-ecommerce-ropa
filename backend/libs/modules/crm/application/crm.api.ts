import { Injectable } from '@nestjs/common';
import { AddressWithoutLocationError } from '../domain/errors';
import { AddressService } from './address.service';

/** Dirección guardada lista para el checkout (mismos campos que acepta POST /checkout). */
export interface CheckoutAddress {
  addressId: string;
  recipientName: string;
  recipientPhone: string;
  mainStreet: string;
  secondaryStreet: string | null;
  number: string | null;
  reference: string | null;
  neighborhood: string | null;
  city: string;
  province: string;
  lat: number;
  lng: number;
}

/** Dirección de la libreta del cliente para el backoffice (ubicación opcional). */
export type CustomerAddress = Omit<CheckoutAddress, 'lat' | 'lng'> & {
  label: string | null;
  isDefault: boolean;
  lat: number | null;
  lng: number | null;
};

/**
 * Fachada síncrona del CRM para otros módulos. Checkout la usa para cobrar con una dirección
 * guardada del cliente (addressId) en lugar de recibirla completa.
 */
@Injectable()
export class CrmApi {
  constructor(private readonly addresses: AddressService) {}

  /**
   * Pedidos asistidos (backoffice): libreta de direcciones del cliente, la predeterminada primero.
   * lat/lng null = sin ubicación (no se puede cotizar el envío hasta marcarla).
   */
  async listCustomerAddresses(tenantId: string, userId: string): Promise<CustomerAddress[]> {
    const list = await this.addresses.list(tenantId, userId);
    return list
      .map((a) => ({
        addressId: a.id,
        label: a.label,
        isDefault: a.isDefault,
        recipientName: a.recipientName,
        recipientPhone: a.recipientPhone,
        mainStreet: a.mainStreet,
        secondaryStreet: a.crossStreet,
        number: a.houseNumber,
        reference: a.reference,
        neighborhood: a.neighborhood,
        city: a.city,
        province: a.province,
        lat: a.location?.lat ?? null,
        lng: a.location?.lng ?? null,
      }))
      .sort((x, y) => Number(y.isDefault) - Number(x.isDefault));
  }

  /** Lanza AddressNotFoundError (ajena o inexistente) o AddressWithoutLocationError (sin pin). */
  async getCheckoutAddress(tenantId: string, userId: string, addressId: string): Promise<CheckoutAddress> {
    const a = await this.addresses.get(tenantId, userId, addressId);
    if (!a.location) throw new AddressWithoutLocationError(addressId);
    return {
      addressId: a.id,
      recipientName: a.recipientName,
      recipientPhone: a.recipientPhone,
      mainStreet: a.mainStreet,
      secondaryStreet: a.crossStreet,
      number: a.houseNumber,
      reference: a.reference,
      neighborhood: a.neighborhood,
      city: a.city,
      province: a.province,
      lat: a.location.lat,
      lng: a.location.lng,
    };
  }
}
