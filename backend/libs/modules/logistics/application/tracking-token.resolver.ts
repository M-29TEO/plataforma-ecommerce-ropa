import { Injectable } from '@nestjs/common';
import { Database } from '../../../shared-kernel';
import { TrackingRepository } from './tracking-ports';

export interface ResolvedTracking {
  tenantId: string;
  orderId: string;
  shipmentId: string;
  status: string;
}

/**
 * Para apps/realtime: a qué pedido corresponde un token de seguimiento (sin tenant: el token es
 * único en toda la base). Solo depende del schema logistics, así el proceso realtime no carga
 * Pedidos, Inventario ni los controladores HTTP.
 */
@Injectable()
export class TrackingTokenResolver {
  constructor(
    private readonly db: Database,
    private readonly tracking: TrackingRepository,
  ) {}

  async resolve(token: string): Promise<ResolvedTracking | null> {
    const s = await this.tracking.findByToken(this.db, token);
    if (!s || s.direction !== 'outbound') return null;
    return { tenantId: s.tenantId, orderId: s.orderId, shipmentId: s.id, status: s.status };
  }
}
