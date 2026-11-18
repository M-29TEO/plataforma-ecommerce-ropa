import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  APP_CONFIG,
  AppConfig,
  ConflictError,
  Database,
  fromCents,
  NotFoundError,
  OutboxWriter,
  Queryable,
  RealtimePublisher,
  StoredObject,
  toCents,
} from '../../../shared-kernel';
import { InventoryApi } from '../../inventory';
import { Actor, OrderNotFoundError, OrdersApi } from '../../orders';
import { deliveryFeeCents, parseCommissionScheme } from '../domain/commission';
import {
  assertCodCollected,
  assertOtpNotLocked,
  CodMethod,
  deliveryOtpCode,
  OTP_FAILURE_WINDOW_MS,
  OtpInvalidError,
  otpHash,
  otpMatches,
  OtpRequiredError,
  ProofFile,
  showsDeliveryCode,
  validateProofFile,
} from '../domain/delivery-proof';
import { RiderNotFoundError, ShipmentNotFoundError } from '../domain/errors';
import { riderCodLimitExceeded, shipmentStatusChanged } from '../domain/events';
import { GeoPoint, haversineMeters } from '../domain/geo';
import { codControl } from '../domain/settlement';
import {
  assertRecentPosition,
  assertShipmentTransition,
  fallbackEtaSeconds,
  isLive,
  LIVE_POSITION_MAX_AGE_MS,
  MAX_DELIVERY_DISTANCE_M,
  NotRiderShipmentError,
  orderRoom,
  orderStepsFor,
  REALTIME_EVENTS,
  ridersRoom,
  RiderSettableStatus,
  STAFF_EVENTS,
  STAFF_NAMESPACE,
  STATUS_DESCRIPTIONS,
  TooFarFromDestinationError,
} from '../domain/tracking';
import { MapsPort, RiderRecord, RiderRepository, ShipmentRepository } from './ports';
import { ClosedOffer, DeliveryProofStorage, DispatchRepository } from './rider-app-ports';
import { EventSource, RiderPosition, StatusPatch, TrackedShipment, TrackingRepository } from './tracking-ports';

export interface PositionInput extends GeoPoint {
  heading?: number;
  speedKmh?: number;
  accuracyM?: number;
  recordedAt?: Date;
}

export interface PublicTracking {
  orderNumber: string | null;
  status: string;
  carrierType: string;
  direction: string;
  destination: { label: string; location: GeoPoint | null };
  origin: { name: string; location: GeoPoint } | null;
  slot: { startsAt: string; endsAt: string } | null;
  eta: string | null;
  deliveredAt: string | null;
  rider: { vehicleType: string; plate: string | null; ratingAvg: string; ratingCount: number } | null;
  /** Solo mientras el motorizado lleva el paquete y la posición es reciente. */
  riderPosition: RiderPosition | null;
  /** Código de entrega (4 dígitos) que el cliente dicta al motorizado; solo mientras va en camino. */
  deliveryCode: string | null;
  events: Array<{ status: string; description: string | null; occurredAt: string }>;
}

/** Envío visto desde la app del motorizado (ya es suyo: incluye contacto y referencia del destino). */
export interface RiderShipment {
  id: string;
  orderId: string;
  orderNumber: string | null;
  status: string;
  pickup: { name: string; location: GeoPoint } | null;
  destination: Record<string, unknown> & {
    label: string;
    location: GeoPoint | null;
    recipientName: string | null;
    phone: string | null;
    reference: string | null;
  };
  slot: { startsAt: string; endsAt: string } | null;
  codAmount: string;
  distanceM: number | null;
  estimatedFee: string;
  requiresOtp: boolean;
  attempts: number;
  deliveredAt: string | null;
}

export interface DeliverInput {
  location: GeoPoint;
  receiverName: string;
  otp?: string;
  codCollected?: string;
  codMethod?: CodMethod;
  photo?: ProofFile;
  signature?: ProofFile;
}

export interface CommittedTransition {
  shipment: TrackedShipment;
  status: string;
  previous: string;
  description: string;
  now: Date;
}

/**
 * Entrega con motorizado y su seguimiento en vivo: asignación (backoffice), estados y posiciones
 * (app del motorizado), entrega con prueba (foto, firma y código) y la vista pública por token.
 * Cada cambio de estado avanza el pedido (Pedidos) en la misma transacción y emite
 * ShipmentStatusChanged por el outbox (Notificaciones avisa al cliente); al confirmar, publica en
 * la sala del pedido para el tracking. El despacho automático (ofertas) está en DispatchService.
 */
@Injectable()
export class TrackingService {
  private readonly logger = new Logger(TrackingService.name);

  constructor(
    private readonly db: Database,
    private readonly tracking: TrackingRepository,
    private readonly shipments: ShipmentRepository,
    private readonly riders: RiderRepository,
    private readonly offers: DispatchRepository,
    private readonly orders: OrdersApi,
    private readonly inventory: InventoryApi,
    private readonly maps: MapsPort,
    private readonly outbox: OutboxWriter,
    private readonly realtime: RealtimePublisher,
    private readonly proofs: DeliveryProofStorage,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ------------------------------------------------------------------ Vista pública y del cliente

  async publicView(tenantId: string, token: string, now = new Date()): Promise<PublicTracking> {
    const s = await this.tracking.findByToken(this.db, token, tenantId);
    if (!s) throw new ShipmentNotFoundError(token);
    const [order, events, rider, origin, position] = await Promise.all([
      this.orders.getOrder(tenantId, s.orderId).catch((e) => (e instanceof OrderNotFoundError ? null : Promise.reject(e))),
      this.tracking.listEvents(this.db, s.id),
      s.riderId ? this.tracking.riderInfo(this.db, s.riderId) : null,
      s.originWarehouseId ? this.inventory.getActiveWarehouse(tenantId, s.originWarehouseId) : null,
      this.livePosition(s, now),
    ]);
    const eta = position && s.destinationLocation ? new Date(now.getTime() + (await this.etaSeconds(position, s.destinationLocation)) * 1000) : s.eta;
    return {
      orderNumber: order?.orderNumber ?? null,
      status: s.status,
      carrierType: s.carrierType,
      direction: s.direction,
      destination: { label: destinationLabel(s.destination), location: s.destinationLocation },
      origin: origin ? { name: origin.name, location: origin.location } : null,
      slot: s.slot,
      eta: s.deliveredAt ? null : (eta?.toISOString() ?? null),
      deliveredAt: s.deliveredAt?.toISOString() ?? null,
      rider,
      riderPosition: position,
      deliveryCode: this.deliveryCode(s),
      events: events.map((e) => ({ ...e, description: e.description ?? STATUS_DESCRIPTIONS[e.status] ?? null })),
    };
  }

  /** Envíos de un pedido del cliente (para enlazar al seguimiento desde "mis pedidos"). */
  async forCustomerOrder(tenantId: string, userId: string, orderId: string) {
    const order = await this.orders.getOrder(tenantId, orderId).catch((e) => (e instanceof OrderNotFoundError ? null : Promise.reject(e)));
    if (!order || order.userId !== userId) throw new OrderNotFoundError(orderId);
    const list = await this.shipments.findByOrder(this.db, tenantId, orderId);
    return list.map((s) => ({
      id: s.id,
      direction: s.direction,
      carrierType: s.carrierType,
      status: s.status,
      trackingToken: s.trackingToken,
      deliveredAt: s.deliveredAt,
      deliveryCode: this.deliveryCode(s),
    }));
  }

  // ------------------------------------------------------------------ Backoffice

  /**
   * Asigna (o reasigna, antes del retiro) un motorizado activo. Contra entrega: respeta su tope de
   * efectivo. Cancela la oferta abierta del despacho automático, si la había.
   */
  async assign(tenantId: string, shipmentId: string, riderId: string, actor: Actor, now = new Date()) {
    const { committed, cancelled } = await this.db.withTransaction(async (tx) => {
      const s = await this.lockShipment(tx, tenantId, shipmentId);
      if (s.carrierType !== 'rider' || s.direction !== 'outbound') throw new NotRiderShipmentError(shipmentId);
      assertShipmentTransition(s.status, 'assigned');
      const rider = await this.riders.lock(tx, riderId);
      if (!rider || rider.tenantId !== tenantId || rider.status !== 'active') throw new RiderNotFoundError(riderId);
      if (toCents(s.codAmount) > 0) {
        const cod = codControl(rider.codBalance, rider.codLimit);
        if (toCents(cod.codAvailable) < toCents(s.codAmount)) {
          throw new ConflictError('RIDER_COD_LIMIT', 'El motorizado no puede recibir más efectivo hasta liquidar', {
            riderId,
            codAvailable: cod.codAvailable,
            codAmount: s.codAmount,
          });
        }
      }
      const cancelled = await this.offers.cancelOpenForShipment(tx, s.id, now);
      return { committed: await this.transition(tx, s, 'assigned', { riderId, assignedAt: now }, actor, 'staff', now), cancelled };
    });
    this.broadcast(committed);
    this.publishOfferEvents(cancelled, 'cancelled');
    return this.summary(committed.shipment, committed.status);
  }

  /** Pruebas de entrega de un envío (backoffice), con el enlace a la foto o firma. */
  async listProofs(tenantId: string, shipmentId: string) {
    const s = await this.tracking.findById(this.db, tenantId, shipmentId);
    if (!s) throw new ShipmentNotFoundError(shipmentId);
    const list = await this.tracking.listProofs(this.db, tenantId, shipmentId);
    return list.map((p) => ({
      id: p.id,
      proofType: p.proofType,
      receiverName: p.receiverName,
      otpVerified: p.otpVerified,
      distanceToDestinationM: p.distanceToDestinationM,
      capturedAt: p.capturedAt.toISOString(),
      fileUrl: p.storageKey ? `/v1/logistics/proofs/${p.id}/file` : null,
    }));
  }

  async proofFile(tenantId: string, proofId: string): Promise<StoredObject> {
    const p = await this.tracking.findProof(this.db, tenantId, proofId);
    const file = p?.storageKey ? await this.proofs.get(p.storageKey) : null;
    if (!file) throw new NotFoundError('PROOF_FILE_NOT_FOUND', 'La prueba no tiene archivo o ya no existe', { id: proofId });
    return file;
  }

  // ------------------------------------------------------------------ App del motorizado

  /** Envíos en curso del motorizado (asignado/aceptado → intento fallido). */
  async activeForRider(tenantId: string, riderUserId: string): Promise<RiderShipment[]> {
    const rider = await this.riderFor(this.db, tenantId, riderUserId);
    const list = await this.tracking.listActiveForRider(this.db, rider.id);
    return Promise.all(list.map((s) => this.riderView(s, rider)));
  }

  /** Un envío propio en cualquier estado (también entregado: pantalla posterior a la entrega). */
  async getForRider(tenantId: string, riderUserId: string, shipmentId: string): Promise<RiderShipment> {
    const rider = await this.riderFor(this.db, tenantId, riderUserId);
    const s = await this.tracking.findById(this.db, tenantId, shipmentId);
    if (!s || s.riderId !== rider.id) throw new ShipmentNotFoundError(shipmentId);
    return this.riderView(s, rider);
  }

  /**
   * Retiro, en camino, llegando e intento fallido. La posición opcional queda en el evento. Al
   * retirar se fija el hash del código de entrega; un intento fallido suma attempts y su motivo
   * queda como descripción del evento.
   */
  async riderStatus(
    tenantId: string,
    riderUserId: string,
    shipmentId: string,
    to: RiderSettableStatus,
    location: GeoPoint | null,
    reason: string | null = null,
    now = new Date(),
  ): Promise<RiderShipment> {
    const { committed, rider } = await this.db.withTransaction(async (tx) => {
      const rider = await this.riderFor(tx, tenantId, riderUserId);
      const s = await this.ownShipment(tx, tenantId, shipmentId, rider);
      assertShipmentTransition(s.status, to);
      const patch: Partial<StatusPatch> = to === 'picked_up' ? { pickedUpAt: now } : {};
      let shipment = s;
      if (to === 'picked_up') {
        const hash = otpHash(deliveryOtpCode(this.config.logistics.deliveryOtpSecret, s.id));
        await this.tracking.setOtpHash(tx, s.id, hash);
        shipment = { ...s, otpHash: hash };
      }
      if (to === 'failed_attempt') {
        await this.tracking.incrementAttempts(tx, s.id);
        shipment = { ...s, attempts: s.attempts + 1 };
      }
      const description = to === 'failed_attempt' && reason ? reason : undefined;
      const committed = await this.transition(tx, shipment, to, patch, { type: 'rider', id: riderUserId }, 'rider_app', now, location, description);
      return { committed, rider };
    });
    this.broadcast(committed);
    return this.riderView(committed.shipment, rider);
  }

  /**
   * Entrega con prueba: foto y firma (validadas por magic bytes), código de entrega si el envío lo
   * tiene y el motorizado cerca del destino. Contra entrega: debe cobrar exactamente el monto; en
   * efectivo suma a su saldo (riders.cod_balance) en la misma transacción, y Pagos captura el pago
   * con OrderDelivered. Un código incorrecto queda registrado (en su propia transacción
   * confirmada) antes de responder 422, así cuenta para el bloqueo.
   */
  async deliver(tenantId: string, riderUserId: string, shipmentId: string, input: DeliverInput, now = new Date()): Promise<RiderShipment> {
    const photo = validateProofFile('photo', input.photo);
    const signature = validateProofFile('signature', input.signature);
    const method: CodMethod = input.codMethod ?? 'cash';

    const result = await this.db.withTransaction(async (tx) => {
      const rider = await this.riderFor(tx, tenantId, riderUserId);
      const s = await this.ownShipment(tx, tenantId, shipmentId, rider);
      assertShipmentTransition(s.status, 'delivered');
      const distance = s.destinationLocation ? Math.round(haversineMeters(input.location, s.destinationLocation)) : 0;
      if (distance > MAX_DELIVERY_DISTANCE_M) throw new TooFarFromDestinationError(distance);
      assertCodCollected(s.codAmount, input.codCollected);

      if (s.otpHash) {
        const failures = await this.tracking.countOtpFailures(tx, s.id, new Date(now.getTime() - OTP_FAILURE_WINDOW_MS));
        const left = assertOtpNotLocked(failures);
        if (!input.otp) throw new OtpRequiredError();
        if (!otpMatches(input.otp, s.otpHash)) {
          await this.tracking.insertProof(tx, {
            shipmentId,
            proofType: 'otp',
            otpVerified: false,
            location: input.location,
            distanceToDestinationM: distance,
            capturedAt: now,
          });
          return { kind: 'otp_failed' as const, attemptsLeft: left - 1 };
        }
      }

      // Recién aquí (todo validado) se suben los archivos: un código errado no deja archivos sueltos.
      const photoKey = `logistics/proofs/${s.id}/${randomUUID()}.${photo.ext}`;
      const signatureKey = `logistics/proofs/${s.id}/${randomUUID()}.${signature.ext}`;
      await this.proofs.put(photoKey, input.photo!.buffer, photo.contentType);
      await this.proofs.put(signatureKey, input.signature!.buffer, signature.contentType);
      const base = { shipmentId, location: input.location, distanceToDestinationM: distance, capturedAt: now };
      await this.tracking.insertProof(tx, { ...base, proofType: 'photo', storageKey: photoKey, receiverName: input.receiverName });
      await this.tracking.insertProof(tx, { ...base, proofType: 'signature', storageKey: signatureKey, receiverName: input.receiverName });
      if (s.otpHash) await this.tracking.insertProof(tx, { ...base, proofType: 'otp', otpVerified: true });

      const patch: Partial<StatusPatch> = { deliveredAt: now, eta: null };
      if (toCents(s.codAmount) > 0) {
        Object.assign(patch, { codCollected: s.codAmount, codMethod: method });
        // card_pos y deuna_qr no pasan por las manos del motorizado: no suman a su efectivo.
        if (method === 'cash') {
          const locked = (await this.riders.lock(tx, rider.id))!;
          const balance = fromCents(toCents(locked.codBalance) + toCents(s.codAmount));
          await this.riders.setCodBalance(tx, rider.id, balance);
          const cod = codControl(balance, locked.codLimit);
          if (cod.overLimit) {
            await this.outbox.append(tx, [riderCodLimitExceeded(tenantId, { riderId: rider.id, codBalance: balance, codLimit: locked.codLimit, detectedAt: now.toISOString() })]);
          }
        }
      }
      const committed = await this.transition(tx, s, 'delivered', patch, { type: 'rider', id: riderUserId }, 'rider_app', now, input.location);
      return { kind: 'delivered' as const, committed, rider };
    });

    if (result.kind === 'otp_failed') throw new OtpInvalidError(result.attemptsLeft);
    this.broadcast(result.committed);
    return this.riderView(result.committed.shipment, result.rider);
  }

  /**
   * Posición del motorizado (cada pocos segundos desde su app). Se guarda en el histórico ligada al
   * envío que lleva y, si el paquete está en camino, se publica al cliente con el ETA. Devuelve
   * cuántas ofertas abiertas tiene: la app las consulta aunque ntfy no le llegue.
   */
  async recordPosition(tenantId: string, riderUserId: string, input: PositionInput, now = new Date()) {
    const recordedAt = input.recordedAt ?? now;
    assertRecentPosition(recordedAt, now);
    const rider = await this.riderFor(this.db, tenantId, riderUserId);
    const active = await this.tracking.listActiveForRider(this.db, rider.id);
    const live = active.filter((s) => isLive(s.status));
    const point = { lat: input.lat, lng: input.lng };

    // Una fila por envío en camino (o una sin envío si no lleva ninguno): el tracking lee por envío.
    const targets: Array<TrackedShipment | null> = live.length > 0 ? live : [null];
    for (const s of targets) {
      await this.tracking.insertPosition(this.db, {
        riderId: rider.id,
        shipmentId: s?.id ?? null,
        ...point,
        heading: input.heading ?? null,
        speedKmh: input.speedKmh ?? null,
        accuracyM: input.accuracyM ?? null,
        recordedAt,
      });
    }
    for (const s of live) {
      const etaSeconds = s.destinationLocation ? await this.etaSeconds(point, s.destinationLocation) : null;
      this.realtime.publish(orderRoom(s.orderId), REALTIME_EVENTS.location, {
        shipmentId: s.id,
        ...point,
        heading: input.heading ?? null,
        speedKmh: input.speedKmh ?? null,
        recordedAt: recordedAt.toISOString(),
        etaSeconds,
      });
    }
    // Mapa en vivo del backoffice: una sola posición por motorizado (con el primer envío en camino).
    this.realtime.publish(
      ridersRoom(tenantId),
      STAFF_EVENTS.location,
      {
        riderId: rider.id,
        ...point,
        heading: input.heading ?? null,
        speedKmh: input.speedKmh ?? null,
        recordedAt: recordedAt.toISOString(),
        shipmentId: live[0]?.id ?? null,
      },
      STAFF_NAMESPACE,
    );
    const openOffers = await this.offers.countOpenForRider(this.db, rider.id, now);
    return { recorded: targets.length, liveShipments: live.map((s) => s.id), openOffers };
  }

  // ------------------------------------------------------------------ Compartido con DispatchService

  /**
   * Cambio de estado dentro de la transacción del llamador: envío, evento, pasos del pedido y
   * ShipmentStatusChanged en el outbox. Después del commit, el llamador invoca broadcast().
   */
  async transition(
    tx: Queryable,
    s: TrackedShipment,
    to: string,
    patch: Partial<StatusPatch>,
    actor: Actor,
    source: EventSource,
    now: Date,
    location: GeoPoint | null = null,
    descriptionOverride?: string,
  ): Promise<CommittedTransition> {
    const description = descriptionOverride ?? STATUS_DESCRIPTIONS[to] ?? to;
    await this.tracking.updateStatus(tx, s.id, { ...patch, status: to });
    await this.tracking.insertEvent(tx, s.id, to, description, source, now, location);

    // El pedido acompaña al envío (preparing → shipped → in_transit → delivered), en la misma transacción.
    const order = await this.orders.getOrder(s.tenantId, s.orderId);
    for (const step of orderStepsFor(to, order.status)) {
      await this.orders.changeStatus(s.tenantId, s.orderId, step, actor);
    }

    await this.outbox.append(tx, [
      shipmentStatusChanged(s.tenantId, {
        shipmentId: s.id,
        orderId: s.orderId,
        returnId: null,
        direction: s.direction,
        carrierType: s.carrierType,
        previousStatus: s.status,
        status: to,
        trackingToken: s.trackingToken,
        description,
        occurredAt: now.toISOString(),
      }),
    ]);
    return { shipment: { ...s, ...patch, status: to } as TrackedShipment, status: to, previous: s.status, description, now };
  }

  /** Después del commit: el cliente que mira el seguimiento actualiza la línea de tiempo. */
  broadcast(c: CommittedTransition): void {
    this.realtime.publish(orderRoom(c.shipment.orderId), REALTIME_EVENTS.status, {
      shipmentId: c.shipment.id,
      status: c.status,
      description: c.description,
      occurredAt: c.now.toISOString(),
    });
    // Despacho y mapa del backoffice (namespace /staff): sin descripción, con el motorizado.
    this.realtime.publish(
      ridersRoom(c.shipment.tenantId),
      STAFF_EVENTS.status,
      { shipmentId: c.shipment.id, orderId: c.shipment.orderId, riderId: c.shipment.riderId, status: c.status },
      STAFF_NAMESPACE,
    );
  }

  /** Cola de despacho del backoffice: cambios de las ofertas (evento dispatch.offer). */
  publishOfferEvents(offers: ClosedOffer[], status: 'offered' | 'accepted' | 'rejected' | 'expired' | 'cancelled'): void {
    for (const o of offers) {
      this.realtime.publish(
        ridersRoom(o.tenantId),
        STAFF_EVENTS.offer,
        { shipmentId: o.shipmentId, riderId: o.riderId, offerId: o.offerId, status },
        STAFF_NAMESPACE,
      );
    }
  }

  /** Vista del envío para la app: recoge en la bodega, entrega en el destino (con contacto). */
  async riderView(s: TrackedShipment, rider: Pick<RiderRecord, 'commissionScheme'>): Promise<RiderShipment> {
    const [order, warehouse] = await Promise.all([
      this.orders.getOrder(s.tenantId, s.orderId).catch((e) => (e instanceof OrderNotFoundError ? null : Promise.reject(e))),
      s.originWarehouseId ? this.inventory.getActiveWarehouse(s.tenantId, s.originWarehouseId) : null,
    ]);
    const d = s.destination;
    const str = (k: string) => (typeof d[k] === 'string' && (d[k] as string).trim() ? (d[k] as string).trim() : null);
    return {
      id: s.id,
      orderId: s.orderId,
      orderNumber: order?.orderNumber ?? null,
      status: s.status,
      pickup: warehouse ? { name: warehouse.name, location: warehouse.location } : null,
      destination: {
        ...d,
        label: destinationLabel(d),
        location: s.destinationLocation,
        recipientName: str('recipientName') ?? order?.customer.name ?? null,
        phone: str('recipientPhone') ?? str('phone') ?? order?.customer.phone ?? null,
        reference: str('reference'),
      },
      slot: s.slot,
      codAmount: s.codAmount,
      distanceM: s.distanceM,
      estimatedFee: estimatedFee(rider.commissionScheme, s.distanceM),
      // Asignado o aceptado: el código se fija al retirar, así que la entrega lo pedirá.
      requiresOtp: s.otpHash !== null || s.status === 'assigned' || s.status === 'accepted',
      attempts: s.attempts,
      deliveredAt: s.deliveredAt?.toISOString() ?? null,
    };
  }

  // ------------------------------------------------------------------ Internos

  private deliveryCode(s: { id: string; carrierType: string; status: string }): string | null {
    return showsDeliveryCode(s) ? deliveryOtpCode(this.config.logistics.deliveryOtpSecret, s.id) : null;
  }

  private summary(s: TrackedShipment, status: string) {
    return { id: s.id, orderId: s.orderId, status, riderId: s.riderId, trackingToken: s.trackingToken };
  }

  private async lockShipment(tx: Queryable, tenantId: string, id: string): Promise<TrackedShipment> {
    const s = await this.tracking.findById(tx, tenantId, id, { lock: true });
    if (!s) throw new ShipmentNotFoundError(id);
    return s;
  }

  /** Envío del propio motorizado; uno ajeno responde 404 (no se revela que existe). */
  private async ownShipment(tx: Queryable, tenantId: string, id: string, rider: RiderRecord): Promise<TrackedShipment> {
    const s = await this.lockShipment(tx, tenantId, id);
    if (s.riderId !== rider.id) throw new ShipmentNotFoundError(id);
    return s;
  }

  async riderFor(q: Queryable, tenantId: string, userId: string): Promise<RiderRecord> {
    const rider = await this.riders.findByUser(q, tenantId, userId);
    if (!rider || rider.status !== 'active') throw new RiderNotFoundError(userId);
    return rider;
  }

  private async livePosition(s: TrackedShipment, now: Date): Promise<RiderPosition | null> {
    if (!s.riderId || !isLive(s.status)) return null;
    return this.tracking.lastPosition(this.db, s.riderId, s.id, new Date(now.getTime() - LIVE_POSITION_MAX_AGE_MS));
  }

  /** ETA por OSRM; si no responde, línea recta a velocidad de ciudad. */
  private async etaSeconds(from: GeoPoint, to: GeoPoint): Promise<number> {
    try {
      return Math.round((await this.maps.route(from, to)).durationS);
    } catch {
      return fallbackEtaSeconds(from, to);
    }
  }
}

/** Comisión estimada de una entrega con el esquema del motorizado ('0.00' si el esquema es inválido). */
export function estimatedFee(scheme: unknown, distanceM: number | null): string {
  try {
    return fromCents(deliveryFeeCents(parseCommissionScheme(scheme), distanceM));
  } catch {
    return '0.00';
  }
}

/** "Av. Amazonas y Naciones Unidas, Quito": sin número, referencia ni datos de contacto. */
export function destinationLabel(d: Record<string, unknown>): string {
  const str = (k: string) => (typeof d[k] === 'string' && (d[k] as string).trim() ? (d[k] as string).trim() : null);
  const street = [str('mainStreet'), str('secondaryStreet')].filter(Boolean).join(' y ');
  return [street || null, str('city')].filter(Boolean).join(', ');
}
