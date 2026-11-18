import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig, Database, fromCents, OutboxWriter, toCents } from '../../../shared-kernel';
import { InventoryApi, ShippingWarehouse } from '../../inventory';
import { CourierReason, decideDelivery } from '../domain/delivery-rules';
import {
  DeliveryQuoteInvalidError,
  DeliveryQuoteMismatchError,
  DeliverySlotRequiredError,
  NoDeliveryCoverageError,
  SlotNotFoundError,
  SlotUnavailableError,
} from '../domain/errors';
import { assertValidPoint, GeoPoint, haversineMeters, samePoint } from '../domain/geo';
import { provinceFor } from '../domain/places';
import { shipmentStatusChanged } from '../domain/events';
import { DeliveryOptionClaims, signDeliveryOption, verifyDeliveryOption } from '../domain/quote-token';
import { chargeableWeightKg, riderPrice } from '../domain/rider-pricing';
import { DeliverySlot, isBookable } from '../domain/slot';
import { CoverageZone, servesRiders } from '../domain/zone';
import { CourierQuoteAggregator } from './courier-quote.aggregator';
import { CourierRepository, ShipmentRepository, SlotRepository, ZoneRepository } from './ports';
import { DistanceSource, RiderDistanceService } from './rider-distance.service';

export interface DeliveryDestination extends GeoPoint {
  city: string;
  province?: string | null;
}

export interface DeliveryQuoteInput {
  tenantId: string;
  destination: DeliveryDestination;
  weightG: number;
  volumeCm3: number;
  /** Total de la mercadería (IVA incluido, con descuentos): define el envío gratis de la zona. */
  merchandiseTotal: string;
}

export interface RiderSlotOption {
  slotId: string;
  date: string;
  startsAt: Date;
  endsAt: Date;
  available: number;
  surcharge: string;
  /** Precio del envío con esta franja (tarifa + recargo). */
  price: string;
}

export interface DeliveryOptionView {
  /** Lo que el checkout devuelve en `deliveryQuoteId`. */
  quoteId: string;
  type: 'rider' | 'courier';
  /** Rider: tarifa sin recargo de franja (ver slots[].price). Courier: precio final. */
  price: string;
  label: string;
  source: 'own_fleet' | 'api' | 'rate_card';
  etaHours: number | null;
  courier?: { code: string; name: string };
  service?: { code: string; name: string };
  distanceKm?: number;
  distanceSource?: DistanceSource;
  breakdown?: Record<string, unknown>;
  slots?: RiderSlotOption[];
}

export interface DeliveryQuote {
  fulfillmentType: 'rider' | 'courier';
  /** Por qué se ofrece courier (null si motorizado). */
  reason: CourierReason | 'ZONE_WAREHOUSE_UNAVAILABLE' | null;
  zone: { id: string; name: string; city: string; deliveryMode: string } | null;
  parcel: { weightG: number; volumeCm3: number; chargeableKg: number };
  validUntil: Date;
  options: DeliveryOptionView[];
}

export interface ResolveDeliveryInput {
  tenantId: string;
  quoteId: string;
  slotId: string | null;
  destination: GeoPoint;
  weightG: number;
  volumeCm3: number;
  merchandiseTotal: string;
  /** Si el cliente indicó un tipo de entrega, debe coincidir con el cotizado. */
  fulfillmentType?: 'rider' | 'courier';
}

/** Opción validada al pagar: lo que se cobra y lo que se reservará. */
export interface ResolvedDelivery {
  fulfillmentType: 'rider' | 'courier';
  shippingTotal: string;
  zoneId: string | null;
  slotId: string | null;
  courierServiceId: string | null;
  courierQuoteId: string | null;
  originWarehouseId: string;
  distanceM: number | null;
  carrierCost: string | null;
  eta: Date | null;
}

export interface BookDeliveryInput {
  tenantId: string;
  orderId: string;
  resolved: ResolvedDelivery;
  /** Bodega real de la asignación de stock (si sale de una sola); si no, la de la cotización. */
  originWarehouseId: string | null;
  destination: { address: Record<string, unknown>; location: GeoPoint; city: string; province?: string | null };
  weightG: number;
  volumeCm3: number;
  codAmount: string;
}

/**
 * DeliveryQuoteService (C4, módulo Logística): cotiza en el checkout.
 *
 *   ZoneResolver (ST_Covers) → DeliveryRulesEngine → RiderPricing (OSRM o línea recta) + SlotService
 *                                                  ↘ CourierQuoteAggregator (API 3 s o courier_rate_cards)
 *
 * Tres pasos, para que el checkout no bloquee filas mientras espera a OSRM o a los couriers:
 *  1. quote(): fuera de toda transacción; devuelve opciones firmadas (quoteId).
 *  2. resolve(): dentro de la transacción del checkout, valida la opción elegida y calcula el
 *     envío a cobrar (sin llamadas externas).
 *  3. book(): en la misma transacción, reserva el cupo de la franja (UPDATE condicional) y crea el
 *     envío 'pending'. Si algo falla después, el ROLLBACK del checkout devuelve el cupo.
 */
@Injectable()
export class DeliveryQuoteService {
  private readonly logger = new Logger(DeliveryQuoteService.name);

  constructor(
    private readonly db: Database,
    private readonly zones: ZoneRepository,
    private readonly slots: SlotRepository,
    private readonly couriers: CourierRepository,
    private readonly shipments: ShipmentRepository,
    private readonly distance: RiderDistanceService,
    private readonly aggregator: CourierQuoteAggregator,
    private readonly inventory: InventoryApi,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly outbox: OutboxWriter,
  ) {}

  async quote(input: DeliveryQuoteInput, now = new Date()): Promise<DeliveryQuote> {
    assertValidPoint(input.destination);
    const point = { lat: input.destination.lat, lng: input.destination.lng };
    const volumeCm3 = Math.max(0, Math.round(input.volumeCm3));
    const parcel = { weightG: input.weightG, volumeCm3, chargeableKg: chargeableWeightKg(input.weightG, volumeCm3) };
    const validUntil = new Date(now.getTime() + this.config.logistics.quoteTtlMinutes * 60_000);
    const exp = Math.floor(validUntil.getTime() / 1000);
    const base = { tid: input.tenantId, lat: point.lat, lng: point.lng, w: input.weightG, vol: volumeCm3, mt: toCents(input.merchandiseTotal), exp };

    const [zone, warehouses] = await Promise.all([
      this.zones.resolve(this.db, input.tenantId, point),
      this.inventory.listShippingWarehouses(input.tenantId),
    ]);
    const until = new Date(now.getTime() + this.config.logistics.slotDaysAhead * 86_400_000);
    const bookable = zone && servesRiders(zone) ? await this.slots.listBookable(this.db, zone.id, now, until) : [];
    const decision = decideDelivery({ zone, weightKg: input.weightG / 1000, bookableSlots: bookable.length });
    const zoneView = zone && { id: zone.id, name: zone.name, city: zone.city, deliveryMode: zone.deliveryMode };

    if (decision.type === 'rider') {
      const origin = warehouses.find((w) => w.id === zone!.servingWarehouseId);
      if (origin) {
        return {
          fulfillmentType: 'rider',
          reason: null,
          zone: zoneView,
          parcel,
          validUntil,
          options: [await this.riderOption(zone!, origin, point, bookable, input, base)],
        };
      }
      this.logger.warn(`La zona ${zone!.id} no tiene una bodega activa que despache: se cotiza por courier`);
    }

    const reason = decision.type === 'courier' ? decision.reason : 'ZONE_WAREHOUSE_UNAVAILABLE';
    const origin = this.courierOrigin(zone, warehouses, point);
    const destProvince = provinceFor(input.destination.city, input.destination.province);
    if (!destProvince) {
      throw new NoDeliveryCoverageError({ reason, hint: 'Indica la provincia de la dirección para cotizar con courier' });
    }
    const options = await this.aggregator.quote({
      tenantId: input.tenantId,
      origin: { city: origin.city, province: provinceFor(origin.city, origin.province) },
      destination: { city: input.destination.city, province: destProvince },
      weightG: input.weightG,
      volumeCm3,
      now,
    });
    if (options.length === 0) throw new NoDeliveryCoverageError({ reason, city: input.destination.city, province: destProvince });

    return {
      fulfillmentType: 'courier',
      reason,
      zone: zoneView,
      parcel,
      validUntil,
      options: options.map((o) => {
        const claims: DeliveryOptionClaims = {
          v: 1,
          ...base,
          typ: 'courier',
          zid: zone?.id ?? null,
          wid: origin.id,
          cq: o.courierQuoteId,
          csid: o.courierServiceId,
          p: toCents(o.price),
          cost: toCents(o.price),
          dm: null,
          ds: null,
          eta: o.etaHours,
        };
        return {
          quoteId: signDeliveryOption(this.config.logistics.quoteSecret, claims),
          type: 'courier' as const,
          price: o.price,
          label: `${o.courier.name} · ${o.service.name}`,
          source: o.source,
          etaHours: o.etaHours,
          courier: o.courier,
          service: o.service,
        };
      }),
    };
  }

  /** Dentro de la transacción del checkout: valida la opción firmada y calcula el envío a cobrar. */
  async resolve(input: ResolveDeliveryInput, now = new Date()): Promise<ResolvedDelivery> {
    const c = verifyDeliveryOption(this.config.logistics.quoteSecret, input.quoteId, now);
    if (c.tid !== input.tenantId) throw new DeliveryQuoteInvalidError();
    if (input.fulfillmentType && input.fulfillmentType !== c.typ) throw new DeliveryQuoteMismatchError('fulfillmentType');
    if (!samePoint(c, input.destination)) throw new DeliveryQuoteMismatchError('shippingAddress');
    if (c.w !== input.weightG || c.vol !== Math.max(0, Math.round(input.volumeCm3))) throw new DeliveryQuoteMismatchError('items');
    if (c.mt !== toCents(input.merchandiseTotal)) throw new DeliveryQuoteMismatchError('total');

    const common = { zoneId: c.zid, originWarehouseId: c.wid, distanceM: c.dm };
    if (c.typ === 'rider') {
      if (!input.slotId) throw new DeliverySlotRequiredError();
      const slot = await this.slots.findSlot(this.db, c.zid!, input.slotId);
      if (!slot) throw new SlotNotFoundError(input.slotId);
      if (!isBookable(slot, now)) throw new SlotUnavailableError(slot.id, slot.cutoffAt <= now ? 'closed' : 'full');
      return {
        ...common,
        fulfillmentType: 'rider',
        shippingTotal: fromCents(c.p + toCents(slot.surcharge)),
        slotId: slot.id,
        courierServiceId: null,
        courierQuoteId: null,
        carrierCost: null,
        eta: slot.endsAt,
      };
    }

    const quote = c.cq ? await this.couriers.findQuote(this.db, input.tenantId, c.cq) : null;
    if (!quote || quote.shipmentId !== null || quote.courierServiceId !== c.csid) throw new DeliveryQuoteInvalidError();
    return {
      ...common,
      fulfillmentType: 'courier',
      shippingTotal: fromCents(c.p),
      slotId: null,
      courierServiceId: c.csid,
      courierQuoteId: c.cq,
      carrierCost: c.cost === null ? null : fromCents(c.cost),
      eta: c.eta === null ? null : new Date(now.getTime() + c.eta * 3_600_000),
    };
  }

  /** Reserva el cupo y crea el envío 'pending' (en la transacción del checkout). */
  book(input: BookDeliveryInput, now = new Date()): Promise<{ shipmentId: string; trackingToken: string }> {
    const r = input.resolved;
    return this.db.withTransaction(async (tx) => {
      if (r.slotId) {
        const booked = await this.slots.book(tx, r.zoneId!, r.slotId, now);
        if (!booked) {
          const slot = await this.slots.findSlot(tx, r.zoneId!, r.slotId);
          throw new SlotUnavailableError(r.slotId, slot && slot.cutoffAt > now ? 'full' : 'closed');
        }
      }
      const trackingToken = randomBytes(18).toString('base64url');
      const shipmentId = await this.shipments.insertPending(tx, {
        tenantId: input.tenantId,
        orderId: input.orderId,
        carrierType: r.fulfillmentType,
        courierServiceId: r.courierServiceId,
        trackingToken,
        originWarehouseId: input.originWarehouseId ?? r.originWarehouseId,
        destination: {
          ...input.destination.address,
          city: input.destination.city,
          province: provinceFor(input.destination.city, input.destination.province),
        },
        destinationLocation: input.destination.location,
        zoneId: r.zoneId,
        deliverySlotId: r.slotId,
        distanceM: r.distanceM,
        weightG: input.weightG,
        volumeCm3: Math.round(input.volumeCm3) || null,
        priceCharged: r.shippingTotal,
        carrierCost: r.carrierCost,
        codAmount: input.codAmount,
        eta: r.eta,
      });
      if (r.courierQuoteId && !(await this.couriers.markSelected(tx, r.courierQuoteId, shipmentId))) {
        throw new DeliveryQuoteInvalidError();
      }
      return { shipmentId, trackingToken };
    });
  }

  /**
   * Pedido cancelado (pago rechazado o vencido, cancelación): cancela sus envíos 'pending' y
   * devuelve el cupo de la franja. Idempotente: un evento repetido no encuentra envíos pendientes.
   */
  cancelForOrder(tenantId: string, orderId: string, reason: string): Promise<{ cancelled: number; releasedSlots: number }> {
    return this.db.withTransaction(async (tx) => {
      const cancelled = await this.shipments.cancelPendingByOrder(tx, tenantId, orderId, reason);
      const occurredAt = new Date().toISOString();
      await this.outbox.append(
        tx,
        cancelled.map((s) =>
          shipmentStatusChanged(tenantId, {
            shipmentId: s.id,
            orderId,
            returnId: null,
            direction: 'outbound',
            carrierType: s.carrierType,
            previousStatus: 'pending',
            status: 'cancelled',
            trackingToken: s.trackingToken,
            description: reason,
            occurredAt,
          }),
        ),
      );
      let releasedSlots = 0;
      for (const s of cancelled) {
        if (s.deliverySlotId && (await this.slots.release(tx, s.deliverySlotId))) releasedSlots++;
      }
      return { cancelled: cancelled.length, releasedSlots };
    });
  }

  private async riderOption(
    zone: CoverageZone,
    origin: ShippingWarehouse,
    point: GeoPoint,
    bookable: DeliverySlot[],
    input: DeliveryQuoteInput,
    base: Pick<DeliveryOptionClaims, 'tid' | 'lat' | 'lng' | 'w' | 'vol' | 'mt' | 'exp'>,
  ): Promise<DeliveryOptionView> {
    const distance = await this.distance.between(origin.location, point);
    const price = riderPrice({
      zone,
      distanceM: distance.distanceM,
      weightG: input.weightG,
      volumeCm3: base.vol,
      merchandiseTotal: input.merchandiseTotal,
    });
    const claims: DeliveryOptionClaims = {
      v: 1,
      ...base,
      typ: 'rider',
      zid: zone.id,
      wid: origin.id,
      cq: null,
      csid: null,
      p: price.priceCents,
      cost: null,
      dm: distance.distanceM,
      ds: distance.source,
      eta: null,
    };
    return {
      quoteId: signDeliveryOption(this.config.logistics.quoteSecret, claims),
      type: 'rider',
      price: fromCents(price.priceCents),
      label: `Motorizado propio · ${zone.name}`,
      source: 'own_fleet',
      etaHours: null,
      distanceKm: price.breakdown.distanceKm,
      distanceSource: distance.source,
      breakdown: price.breakdown,
      slots: bookable.map((s) => ({
        slotId: s.id,
        date: s.slotDate,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        available: s.capacity - s.booked,
        surcharge: s.surcharge,
        price: fromCents(price.priceCents + toCents(s.surcharge)),
      })),
    };
  }

  /** Origen del courier: la bodega de la zona si la hay; si no, la bodega activa más cercana. */
  private courierOrigin(zone: CoverageZone | null, warehouses: ShippingWarehouse[], point: GeoPoint): ShippingWarehouse {
    const own = zone?.servingWarehouseId ? warehouses.find((w) => w.id === zone.servingWarehouseId) : undefined;
    if (own) return own;
    const nearest = [...warehouses].sort((a, b) => haversineMeters(a.location, point) - haversineMeters(b.location, point))[0];
    if (!nearest) throw new NoDeliveryCoverageError({ reason: 'NO_SHIPPING_WAREHOUSE' });
    return nearest;
  }
}
