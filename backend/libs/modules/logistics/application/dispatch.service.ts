import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig, ConflictError, Database, toCents } from '../../../shared-kernel';
import { InventoryApi } from '../../inventory';
import {
  assertOfferOpen,
  DISPATCH_POSITION_MAX_AGE_MS,
  isDispatchable,
  NoRiderAvailableError,
  OfferClosedError,
  OfferNotFoundError,
  rankCandidates,
  ShipmentNotDispatchableError,
} from '../domain/dispatch';
import { ShipmentNotFoundError } from '../domain/errors';
import { GeoPoint } from '../domain/geo';
import { codControl } from '../domain/settlement';
import { NotRiderShipmentError } from '../domain/tracking';
import { RiderRepository } from './ports';
import { ClosedOffer, DispatchRepository, OfferRecord, RiderAppRepository, RiderOfferNotifier } from './rider-app-ports';
import { TrackedShipment, TrackingRepository } from './tracking-ports';
import { destinationLabel, estimatedFee, RiderShipment, TrackingService } from './tracking.service';

export interface OfferCreated {
  offerId: string;
  riderId: string;
  expiresAt: string;
}

export interface RiderOffer {
  id: string;
  shipmentId: string;
  offeredAt: string;
  expiresAt: string;
  pickup: { name: string; location: GeoPoint | null };
  dropoff: { label: string; location: GeoPoint | null };
  distanceM: number | null;
  estimatedFee: string;
  codAmount: string;
  slot: { startsAt: string; endsAt: string } | null;
}

/** Ofertas que vence o reofrece el job en cada pasada (protege el tiempo de una ejecución). */
const SWEEP_BATCH = 50;

/** Tópico de ntfy del motorizado: difícil de adivinar (los tópicos de ntfy son públicos). */
export function newNtfyTopic(): string {
  return `rider-${randomBytes(18).toString('base64url')}`;
}

/**
 * Despacho automático: ofrece cada envío con motorizado al mejor candidato (domain/dispatch), le
 * avisa por ntfy y al backoffice por Socket.IO (dispatch.offer), y resuelve la aceptación, el
 * rechazo y el vencimiento de las ofertas. Toda oferta se crea o se acepta con la fila del envío
 * bloqueada (FOR UPDATE): dos motorizados no pueden aceptar el mismo envío.
 */
@Injectable()
export class DispatchService {
  private readonly logger = new Logger(DispatchService.name);

  constructor(
    private readonly db: Database,
    private readonly offers: DispatchRepository,
    private readonly tracking: TrackingRepository,
    private readonly trackingService: TrackingService,
    private readonly riders: RiderRepository,
    private readonly riderApp: RiderAppRepository,
    private readonly inventory: InventoryApi,
    private readonly notifier: RiderOfferNotifier,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ------------------------------------------------------------------ Crear ofertas

  /** Backoffice: despachar ya. 409 NO_RIDER_AVAILABLE si nadie puede recibirlo. */
  async dispatchNow(tenantId: string, shipmentId: string, now = new Date()): Promise<OfferCreated> {
    const offer = await this.dispatch(tenantId, shipmentId, now, { strict: true });
    if (!offer) throw new NoRiderAvailableError(shipmentId);
    return offer;
  }

  /**
   * Ofrece el envío al mejor candidato. Si ya tiene una oferta abierta vigente, la devuelve (es
   * idempotente: el consumidor puede recibir el mismo evento dos veces). null si no hay candidatos
   * o, sin `strict`, si el envío ya no se puede despachar.
   */
  async dispatch(tenantId: string, shipmentId: string, now = new Date(), opts: { strict?: boolean } = {}): Promise<OfferCreated | null> {
    const ttlMs = this.config.logistics.dispatchOfferTtlSeconds * 1000;
    const result = await this.db.withTransaction(async (tx) => {
      const s = await this.tracking.findById(tx, tenantId, shipmentId, { lock: true });
      if (!s) {
        if (opts.strict) throw new ShipmentNotFoundError(shipmentId);
        return null;
      }
      if (!isDispatchable(s)) {
        if (!opts.strict) return null;
        if (s.carrierType !== 'rider' || s.direction !== 'outbound') throw new NotRiderShipmentError(shipmentId);
        throw new ShipmentNotDispatchableError(shipmentId, s.status);
      }
      const expired: ClosedOffer[] = [];
      const open = await this.offers.findOpenForShipment(tx, s.id);
      if (open && open.expiresAt > now) {
        return { existing: open, created: null, expired, topic: null };
      }
      if (open) {
        await this.offers.respond(tx, open.id, 'expired', now);
        expired.push({ offerId: open.id, shipmentId: s.id, riderId: open.riderId, tenantId });
      }

      const pickup = await this.pickupPoint(s);
      const candidates = await this.offers.listCandidates(tx, tenantId, s.id, new Date(now.getTime() - DISPATCH_POSITION_MAX_AGE_MS), now);
      const best = rankCandidates(candidates, { pickup, codAmount: s.codAmount }, now)[0];
      if (!best) return { existing: null, created: null, expired, topic: null };

      const created = await this.offers.insertOffer(tx, {
        shipmentId: s.id,
        riderId: best.riderId,
        score: best.score,
        breakdown: best.breakdown,
        offeredAt: now,
        expiresAt: new Date(now.getTime() + ttlMs),
      });
      const topic = await this.riderApp.ensureNtfyTopic(tx, best.riderId, newNtfyTopic());
      return { existing: null, created, expired, topic };
    });
    if (!result) return null;

    this.trackingService.publishOfferEvents(result.expired, 'expired');
    if (result.existing) return toCreated(result.existing);
    if (!result.created) return null;
    this.trackingService.publishOfferEvents([{ offerId: result.created.id, shipmentId, riderId: result.created.riderId, tenantId }], 'offered');
    await this.notify(result.topic!);
    return toCreated(result.created);
  }

  // ------------------------------------------------------------------ App del motorizado

  /** Ofertas abiertas del motorizado, sin datos de contacto del cliente (todavía no aceptó). */
  async listForRider(tenantId: string, riderUserId: string, now = new Date()): Promise<RiderOffer[]> {
    const rider = await this.trackingService.riderFor(this.db, tenantId, riderUserId);
    const open = await this.offers.listOpenForRider(this.db, rider.id, now);
    const views = await Promise.all(
      open.map(async (o) => {
        const s = await this.tracking.findById(this.db, tenantId, o.shipmentId);
        if (!s) return null;
        const warehouse = s.originWarehouseId ? await this.inventory.getActiveWarehouse(tenantId, s.originWarehouseId) : null;
        return {
          id: o.id,
          shipmentId: s.id,
          offeredAt: o.offeredAt.toISOString(),
          expiresAt: o.expiresAt.toISOString(),
          pickup: { name: warehouse?.name ?? 'Bodega', location: warehouse?.location ?? null },
          dropoff: { label: destinationLabel(s.destination), location: s.destinationLocation },
          distanceM: s.distanceM,
          estimatedFee: estimatedFee(rider.commissionScheme, s.distanceM),
          codAmount: s.codAmount,
          slot: s.slot,
        };
      }),
    );
    return views.filter((v): v is RiderOffer => v !== null);
  }

  /** Acepta: el envío pasa a 'accepted' con este motorizado. 409 OFFER_EXPIRED / OFFER_CLOSED. */
  async accept(tenantId: string, riderUserId: string, offerId: string, now = new Date()): Promise<RiderShipment> {
    const { committed, rider, offer } = await this.db.withTransaction(async (tx) => {
      const rider = await this.trackingService.riderFor(tx, tenantId, riderUserId);
      const found = await this.offers.findOffer(tx, offerId);
      if (!found || found.riderId !== rider.id) throw new OfferNotFoundError(offerId);
      // Primero el envío (mismo orden de bloqueo que dispatch), luego la oferta.
      const s = await this.tracking.findById(tx, tenantId, found.shipmentId, { lock: true });
      if (!s) throw new OfferNotFoundError(offerId);
      const offer = (await this.offers.findOffer(tx, offerId, { lock: true }))!;
      assertOfferOpen(offer, now);
      if (!isDispatchable(s)) throw new OfferClosedError('cancelled');

      if (toCents(s.codAmount) > 0) {
        const locked = (await this.riders.lock(tx, rider.id))!;
        const cod = codControl(locked.codBalance, locked.codLimit);
        if (toCents(cod.codAvailable) < toCents(s.codAmount)) {
          throw new ConflictError('RIDER_COD_LIMIT', 'Tienes demasiado efectivo sin liquidar para este envío contra entrega', {
            codAvailable: cod.codAvailable,
            codAmount: s.codAmount,
          });
        }
      }
      await this.offers.respond(tx, offer.id, 'accepted', now);
      const committed = await this.trackingService.transition(
        tx,
        s,
        'accepted',
        { riderId: rider.id, assignedAt: now },
        { type: 'rider', id: riderUserId },
        'rider_app',
        now,
      );
      return { committed, rider, offer };
    });
    this.trackingService.broadcast(committed);
    this.trackingService.publishOfferEvents([{ offerId: offer.id, shipmentId: offer.shipmentId, riderId: offer.riderId, tenantId }], 'accepted');
    return this.trackingService.riderView(committed.shipment, rider);
  }

  /** Rechaza y ofrece de inmediato al siguiente candidato. */
  async reject(tenantId: string, riderUserId: string, offerId: string, reason: string | null, now = new Date()): Promise<void> {
    const offer = await this.db.withTransaction(async (tx) => {
      const rider = await this.trackingService.riderFor(tx, tenantId, riderUserId);
      const found = await this.offers.findOffer(tx, offerId);
      if (!found || found.riderId !== rider.id) throw new OfferNotFoundError(offerId);
      const s = await this.tracking.findById(tx, tenantId, found.shipmentId, { lock: true });
      if (!s) throw new OfferNotFoundError(offerId);
      const offer = (await this.offers.findOffer(tx, offerId, { lock: true }))!;
      assertOfferOpen(offer, now);
      await this.offers.respond(tx, offer.id, 'rejected', now, reason);
      return offer;
    });
    this.trackingService.publishOfferEvents([{ offerId: offer.id, shipmentId: offer.shipmentId, riderId: offer.riderId, tenantId }], 'rejected');
    await this.redispatch(tenantId, offer.shipmentId, now);
  }

  // ------------------------------------------------------------------ Worker y eventos

  /**
   * Pasada del job: vence las ofertas sin respuesta y ofrece esos envíos al siguiente; después
   * intenta despachar los envíos listos que quedaron sin oferta (p. ej. nadie estaba disponible y
   * luego alguien inició turno). Con tenantId solo toca ese tenant (tests).
   */
  async sweep(now = new Date(), tenantId?: string): Promise<{ expired: number; offered: number }> {
    let expired = 0;
    let offered = 0;
    const due = await this.offers.listDue(this.db, now, SWEEP_BATCH, tenantId);
    for (const d of due) {
      const closed = await this.db.withTransaction(async (tx) => {
        await this.tracking.findById(tx, d.tenantId, d.shipmentId, { lock: true });
        const offer = await this.offers.findOffer(tx, d.offerId, { lock: true });
        if (!offer || offer.response !== null || offer.expiresAt > now) return false;
        await this.offers.respond(tx, offer.id, 'expired', now);
        return true;
      });
      if (!closed) continue;
      expired += 1;
      this.trackingService.publishOfferEvents([d], 'expired');
      if (await this.redispatch(d.tenantId, d.shipmentId, now)) offered += 1;
    }
    for (const u of await this.offers.listUndispatched(this.db, SWEEP_BATCH, tenantId)) {
      if (await this.redispatch(u.tenantId, u.shipmentId, now)) offered += 1;
    }
    return { expired, offered };
  }

  /** Ofrece al siguiente sin propagar errores (lo llaman el rechazo, el job y el fin de turno). */
  async redispatch(tenantId: string, shipmentId: string, now = new Date()): Promise<boolean> {
    try {
      return (await this.dispatch(tenantId, shipmentId, now)) !== null;
    } catch (error) {
      this.logger.warn(`No se pudo despachar el envío ${shipmentId}: ${(error as Error).message}`);
      return false;
    }
  }

  // ------------------------------------------------------------------ Internos

  /** Donde retira: la bodega de origen; si no está activa, el destino (mejor que nada para el puntaje). */
  private async pickupPoint(s: TrackedShipment): Promise<GeoPoint | null> {
    const warehouse = s.originWarehouseId ? await this.inventory.getActiveWarehouse(s.tenantId, s.originWarehouseId) : null;
    return warehouse?.location ?? s.destinationLocation;
  }

  /** Después del commit y sin romper el flujo: si ntfy falla, la app igual ve la oferta al consultar. */
  private async notify(topic: string): Promise<void> {
    try {
      await this.notifier.notifyOffer({ topic, ttlSeconds: this.config.logistics.dispatchOfferTtlSeconds });
    } catch (error) {
      this.logger.warn(`No se pudo avisar la oferta por ntfy: ${(error as Error).message}`);
    }
  }
}

function toCreated(o: OfferRecord): OfferCreated {
  return { offerId: o.id, riderId: o.riderId, expiresAt: o.expiresAt.toISOString() };
}

