import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig, Database, fromCents, RealtimePublisher, toCents } from '../../../shared-kernel';
import { IamApi } from '../../iam';
import { OrderNotFoundError, OrdersApi } from '../../orders';
import { deliveryFeeCents, parseCommissionScheme } from '../domain/commission';
import { earningsPeriod, summarizeEarnings } from '../domain/earnings';
import { RiderNotFoundError } from '../domain/errors';
import { GeoPoint } from '../domain/geo';
import { codControl } from '../domain/settlement';
import {
  assertCanEndShift,
  NoActiveShiftError,
  onDemandShiftWindow,
  scheduledShiftCovering,
  ShiftAlreadyActiveError,
  ShiftRecord,
  shiftView,
  ShiftView,
} from '../domain/shift';
import { ridersRoom, STAFF_EVENTS, STAFF_NAMESPACE } from '../domain/tracking';
import { DispatchService, newNtfyTopic } from './dispatch.service';
import { DispatchRepository, RiderAppRepository, RiderProfile } from './rider-app-ports';
import { TrackingRepository } from './tracking-ports';
import { TrackingService } from './tracking.service';

/**
 * App del motorizado: su perfil (con el tópico de ntfy al que se suscribe), turnos y ganancias.
 * Iniciar turno lo deja 'available' para el despacho automático; terminarlo lo deja 'offline',
 * cancela sus ofertas abiertas y las ofrece a otros.
 */
@Injectable()
export class RiderAppService {
  constructor(
    private readonly db: Database,
    private readonly repo: RiderAppRepository,
    private readonly offers: DispatchRepository,
    private readonly tracking: TrackingRepository,
    private readonly trackingService: TrackingService,
    private readonly dispatch: DispatchService,
    private readonly iam: IamApi,
    private readonly orders: OrdersApi,
    private readonly realtime: RealtimePublisher,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async me(tenantId: string, userId: string) {
    const p = await this.profile(tenantId, userId);
    const [contact, topic, shift] = await Promise.all([
      this.iam.getContact(tenantId, userId),
      p.ntfyTopic ? p.ntfyTopic : this.repo.ensureNtfyTopic(this.db, p.riderId, newNtfyTopic()),
      this.repo.findActiveShift(this.db, p.riderId),
    ]);
    const fullName = [contact?.firstName, contact?.lastName].filter((x) => x && x.trim()).join(' ');
    const cod = codControl(p.codBalance, p.codLimit);
    return {
      riderId: p.riderId,
      userId: p.userId,
      name: fullName || contact?.email || null,
      email: contact?.email ?? null,
      vehicleType: p.vehicleType,
      plate: p.plate,
      status: p.status,
      presence: p.presence,
      ratingAvg: p.ratingAvg,
      ratingCount: p.ratingCount,
      codBalance: cod.codBalance,
      codLimit: cod.codLimit,
      codAvailable: cod.codAvailable,
      maxConcurrent: p.maxConcurrent,
      ntfy: { url: this.config.logistics.ntfyPublicUrl, topic },
      shift: shift ? shiftView(shift) : null,
    };
  }

  /**
   * Inicia (check-in) el turno programado que cubre ahora o uno a demanda. Con lat/lng registra
   * la posición, así el despacho ya lo considera sin esperar al siguiente reporte del GPS.
   */
  async startShift(tenantId: string, userId: string, location: GeoPoint | null, now = new Date()): Promise<ShiftView> {
    const p = await this.profile(tenantId, userId);
    const shift = await this.db.withTransaction(async (tx) => {
      await this.repo.lockRider(tx, p.riderId);
      const active = await this.repo.findActiveShift(tx, p.riderId);
      if (active) throw new ShiftAlreadyActiveError(active.id);
      const scheduled = scheduledShiftCovering(await this.repo.listScheduledCovering(tx, p.riderId, now), now);
      let shift: ShiftRecord;
      if (scheduled) {
        shift = await this.repo.activateShift(tx, scheduled.id, now);
      } else {
        const window = onDemandShiftWindow(now, this.config.logistics.riderShiftDefaultHours);
        shift = await this.repo.insertActiveShift(tx, { riderId: p.riderId, zoneId: p.homeZoneId, ...window, checkedInAt: now });
      }
      await this.repo.setPresence(tx, p.riderId, 'available');
      if (location) {
        await this.tracking.insertPosition(tx, {
          riderId: p.riderId,
          shipmentId: null,
          ...location,
          heading: null,
          speedKmh: null,
          accuracyM: null,
          recordedAt: now,
        });
      }
      return shift;
    });
    this.publishPresence(tenantId, p.riderId, 'available', now);
    return shiftView(shift);
  }

  /** Cierra el turno con el resumen de lo entregado durante él. */
  async endShift(tenantId: string, userId: string, now = new Date()) {
    const p = await this.profile(tenantId, userId);
    const { shift, cancelled, delivered } = await this.db.withTransaction(async (tx) => {
      await this.repo.lockRider(tx, p.riderId);
      const active = await this.repo.findActiveShift(tx, p.riderId);
      if (!active) throw new NoActiveShiftError();
      const shipments = await this.tracking.listActiveForRider(tx, p.riderId);
      assertCanEndShift(shipments.map((s) => s.id));
      const startedAt = active.checkedInAt ?? active.startsAt;
      const delivered = await this.repo.listDelivered(tx, p.riderId, startedAt, new Date(now.getTime() + 1));
      const shift = await this.repo.completeShift(tx, active.id, now);
      await this.repo.setPresence(tx, p.riderId, 'offline');
      const cancelled = await this.offers.cancelOpenForRider(tx, p.riderId, now);
      return { shift, cancelled, delivered };
    });

    this.publishPresence(tenantId, p.riderId, 'offline', now);
    this.trackingService.publishOfferEvents(cancelled, 'cancelled');
    for (const c of cancelled) await this.dispatch.redispatch(c.tenantId, c.shipmentId, now);

    const scheme = this.scheme(p);
    const fees = scheme ? delivered.reduce((sum, d) => sum + deliveryFeeCents(scheme, d.distanceM), 0) : 0;
    const cod = delivered.reduce((sum, d) => sum + (d.codCollected ? toCents(d.codCollected) : 0), 0);
    return { shift: shiftView(shift), summary: { deliveries: delivered.length, fees: fromCents(fees), codCollected: fromCents(cod) } };
  }

  /** Ganancias del rango (por defecto, la semana en curso), con el efectivo que tiene en mano. */
  async earnings(tenantId: string, userId: string, from: string | undefined, to: string | undefined, now = new Date()) {
    const p = await this.profile(tenantId, userId);
    const period = earningsPeriod(from, to, now);
    const delivered = await this.repo.listDelivered(this.db, p.riderId, period.startAt, period.endAt);
    const summary = summarizeEarnings(delivered, parseCommissionScheme(p.commissionScheme), period, now);
    const numbers = new Map<string, string | null>();
    await Promise.all(
      [...new Set(summary.items.map((i) => i.orderId))].map(async (orderId) => {
        const order = await this.orders.getOrder(tenantId, orderId).catch((e) => (e instanceof OrderNotFoundError ? null : Promise.reject(e)));
        numbers.set(orderId, order?.orderNumber ?? null);
      }),
    );
    const cod = codControl(p.codBalance, p.codLimit);
    return {
      ...summary,
      codBalance: cod.codBalance,
      codLimit: cod.codLimit,
      codAvailable: cod.codAvailable,
      items: summary.items.map((i) => ({ ...i, orderNumber: numbers.get(i.orderId) ?? null })),
    };
  }

  // ------------------------------------------------------------------ Internos

  private async profile(tenantId: string, userId: string): Promise<RiderProfile> {
    const p = await this.repo.findProfile(this.db, tenantId, userId);
    if (!p || p.status !== 'active') throw new RiderNotFoundError(userId);
    return p;
  }

  private scheme(p: RiderProfile) {
    try {
      return parseCommissionScheme(p.commissionScheme);
    } catch {
      return null;
    }
  }

  /** Igual que LiveOpsService.setPresence: el mapa del backoffice se entera del cambio. */
  private publishPresence(tenantId: string, riderId: string, presence: string, now: Date): void {
    this.realtime.publish(ridersRoom(tenantId), STAFF_EVENTS.presence, { riderId, presence, changedAt: now.toISOString() }, STAFF_NAMESPACE);
  }
}
