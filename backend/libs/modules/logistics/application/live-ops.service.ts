import { Injectable } from '@nestjs/common';
import { Database, RealtimePublisher } from '../../../shared-kernel';
import { IamApi } from '../../iam';
import { RiderNotFoundError } from '../domain/errors';
import { ridersRoom, RiderPresence, STAFF_EVENTS, STAFF_NAMESPACE } from '../domain/tracking';
import { ActiveShipmentRow, LiveOpsRepository, ShipmentListFilter } from './live-ops-ports';
import { destinationLabel } from './tracking.service';

/** Posiciones más viejas que esto no se muestran en el mapa (el motorizado no ha reportado en el día). */
export const LIVE_MAP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Backoffice de logística: mapa en vivo de motorizados y cola de despacho (solo lectura), más la
 * presencia que el motorizado fija desde su app. Nombre y teléfono vienen de IAM (IamApi), no de
 * un join con iam.users.
 */
@Injectable()
export class LiveOpsService {
  constructor(
    private readonly db: Database,
    private readonly repo: LiveOpsRepository,
    private readonly iam: IamApi,
    private readonly realtime: RealtimePublisher,
  ) {}

  async liveRiders(tenantId: string, now = new Date()) {
    const riders = await this.repo.listRiders(this.db, tenantId, new Date(now.getTime() - LIVE_MAP_WINDOW_MS));
    const [shipments, contacts] = await Promise.all([
      this.repo.listActiveShipments(
        this.db,
        tenantId,
        riders.map((r) => r.riderId),
      ),
      // Un motorizado por consulta: la flota de un tenant es de decenas, no de miles.
      Promise.all(riders.map((r) => this.iam.getContact(tenantId, r.userId))),
    ]);
    const byRider = new Map<string, Omit<ActiveShipmentRow, 'riderId'>[]>();
    for (const { riderId, ...s } of shipments) byRider.set(riderId, [...(byRider.get(riderId) ?? []), s]);

    return riders.map((r, i) => {
      const c = contacts[i];
      const fullName = [c?.firstName, c?.lastName].filter((x) => x && x.trim()).join(' ');
      return {
        riderId: r.riderId,
        userId: r.userId,
        name: fullName || c?.email || null,
        phone: c?.phone ?? null,
        vehicleType: r.vehicleType,
        plate: r.plate,
        status: r.status,
        presence: r.presence,
        codBalance: r.codBalance,
        codLimit: r.codLimit,
        ratingAvg: r.ratingAvg,
        lastLocation: r.lastLocation,
        activeShipments: byRider.get(r.riderId) ?? [],
      };
    });
  }

  async listShipments(tenantId: string, filter: ShipmentListFilter) {
    const { rows, total } = await this.repo.listShipments(this.db, tenantId, filter);
    return {
      items: rows.map(({ destination, ...s }) => ({ ...s, destinationLabel: destinationLabel(destination) })),
      total,
    };
  }

  /** App del motorizado: disponible, en pausa o desconectado. Se avisa al mapa del backoffice. */
  async setPresence(tenantId: string, riderUserId: string, presence: RiderPresence, now = new Date()) {
    const updated = await this.repo.setPresence(this.db, tenantId, riderUserId, presence);
    if (!updated) throw new RiderNotFoundError(riderUserId);
    this.realtime.publish(
      ridersRoom(tenantId),
      STAFF_EVENTS.presence,
      { riderId: updated.riderId, presence, changedAt: now.toISOString() },
      STAFF_NAMESPACE,
    );
    return { riderId: updated.riderId, presence };
  }
}
