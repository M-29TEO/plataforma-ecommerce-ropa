import { Injectable } from '@nestjs/common';
import { Database } from '../../../shared-kernel';
import { DispatchRun, NotificationDispatcher } from './notification-dispatcher.service';
import { NotificationService, NotifyRequest, NotifyResult } from './notification.service';
import { NotificationFilter, NotificationRepository, NotificationView } from './ports';

/** Fachada del módulo: encolar un mensaje del catálogo, despachar la cola y consultar lo enviado. */
@Injectable()
export class NotificationsApi {
  constructor(
    private readonly db: Database,
    private readonly service: NotificationService,
    private readonly dispatcher: NotificationDispatcher,
    private readonly notifications: NotificationRepository,
  ) {}

  /** Dentro de la transacción del llamador (se une a ella). Idempotente por dedupe_key. */
  notify(req: NotifyRequest): Promise<NotifyResult> {
    return this.service.notify(req);
  }

  dispatchDue(now?: Date, limit?: number, tenantId?: string): Promise<DispatchRun> {
    return this.dispatcher.dispatchDue(now, limit, tenantId);
  }

  list(tenantId: string, filter: NotificationFilter): Promise<NotificationView[]> {
    return this.notifications.list(this.db, tenantId, filter);
  }
}
