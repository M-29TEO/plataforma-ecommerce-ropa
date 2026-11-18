import { Injectable } from '@nestjs/common';
import { Queryable } from '../database/database';

export interface AuditEntry {
  tenantId: string;
  /** null si no hay un usuario detrás (p. ej. una detección automática). */
  actorId: string | null;
  /** 'staff', 'customer', 'rider' o 'system'. */
  actorType: string;
  actorIp?: string | null;
  /** Verbo con prefijo del módulo: 'iam.role.assigned', 'auth.refresh_reused'... */
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  requestId?: string | null;
}

/**
 * Auditoría de solo inserción (platform.audit_log, particionada por mes). Se escribe con el
 * MISMO cliente de la transacción del cambio: si el cambio hace ROLLBACK, su auditoría también.
 */
@Injectable()
export class AuditLog {
  async record(tx: Queryable, e: AuditEntry): Promise<void> {
    await tx.query(
      `INSERT INTO platform.audit_log
         (tenant_id, actor_id, actor_type, actor_ip, action, entity_type, entity_id, before, after, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)`,
      [
        e.tenantId,
        e.actorId,
        e.actorType,
        e.actorIp ?? null,
        e.action,
        e.entityType,
        e.entityId,
        e.before === undefined ? null : JSON.stringify(e.before),
        e.after === undefined ? null : JSON.stringify(e.after),
        e.requestId ?? null,
      ],
    );
  }
}
