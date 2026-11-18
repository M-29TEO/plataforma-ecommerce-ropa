import { Injectable, OnModuleInit } from '@nestjs/common';
import { AnonymizationResult, Database, DataSubject, PersonalDataContributor, PersonalDataRegistry } from '../../../shared-kernel';

interface NotificationRow {
  channel: string;
  template_code: string;
  status: string;
  created_at: Date;
  sent_at: Date | null;
}

interface SubscriptionRow {
  endpoint: string;
  user_agent: string | null;
  created_at: Date;
}

/** Solo el host del servicio push (fcm.googleapis.com...): la ruta del endpoint identifica al navegador. */
function endpointHost(endpoint: string): string | null {
  try {
    return new URL(endpoint).host;
  } catch {
    return null;
  }
}

/**
 * LOPDP en Notificaciones (schema platform: notifications, push_subscriptions). Exporta el
 * historial de envíos del titular (canal, plantilla, estado, fechas; sin el contenido) y sus
 * suscripciones push (host del servicio, navegador, fecha; nunca el endpoint completo ni las claves).
 *
 * Anonimiza: borra sus suscripciones push (sin ellas no se le puede volver a escribir); en sus
 * notificaciones (por user_id o, las de invitado, por email) recipient = 'anonimizado', payload
 * '{}' y error NULL; las que seguían en cola pasan a 'suppressed' para que el despachador no las
 * tome (solo reclama status = 'queued'). Se conserva la fila (canal, plantilla, estado, fechas)
 * como registro de qué se envió y cuándo.
 */
@Injectable()
export class NotificationsPersonalDataContributor extends PersonalDataContributor implements OnModuleInit {
  readonly section = 'notificaciones';

  constructor(
    private readonly registry: PersonalDataRegistry,
    private readonly db: Database,
  ) {
    super();
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  async exportData(subject: DataSubject): Promise<unknown> {
    const { rows: notifications } = await this.db.query<NotificationRow>(
      `SELECT channel, template_code, status, created_at, sent_at
         FROM platform.notifications
        WHERE tenant_id = $1 AND (user_id = $2 OR ($3::text IS NOT NULL AND lower(recipient) = lower($3)))
        ORDER BY created_at`,
      [subject.tenantId, subject.userId, subject.email],
    );
    // push_subscriptions no tiene tenant_id: el user_id ya es de un solo tenant (iam.users).
    const { rows: subscriptions } = await this.db.query<SubscriptionRow>(
      `SELECT endpoint, user_agent, created_at FROM platform.push_subscriptions WHERE user_id = $1 ORDER BY created_at`,
      [subject.userId],
    );
    return {
      notifications: notifications.map((n) => ({
        channel: n.channel,
        templateCode: n.template_code,
        status: n.status,
        createdAt: n.created_at.toISOString(),
        sentAt: n.sent_at ? n.sent_at.toISOString() : null,
      })),
      pushSubscriptions: subscriptions.map((s) => ({
        endpointHost: endpointHost(s.endpoint),
        userAgent: s.user_agent,
        createdAt: s.created_at.toISOString(),
      })),
    };
  }

  async anonymize(subject: DataSubject): Promise<AnonymizationResult> {
    const subscriptions = await this.db.query(`DELETE FROM platform.push_subscriptions WHERE user_id = $1`, [subject.userId]);
    const notifications = await this.db.query(
      `UPDATE platform.notifications
          SET recipient = 'anonimizado', payload = '{}'::jsonb, error = NULL,
              status = CASE WHEN status = 'queued' THEN 'suppressed' ELSE status END,
              next_attempt_at = CASE WHEN status = 'queued' THEN NULL ELSE next_attempt_at END
        WHERE tenant_id = $1 AND (user_id = $2 OR ($3::text IS NOT NULL AND lower(recipient) = lower($3)))`,
      [subject.tenantId, subject.userId, subject.email],
    );
    return {
      affected: (subscriptions.rowCount ?? 0) + (notifications.rowCount ?? 0),
      retained: ['Registro de notificaciones enviadas (canal, plantilla, estado y fecha), sin destinatario ni contenido'],
    };
  }
}
