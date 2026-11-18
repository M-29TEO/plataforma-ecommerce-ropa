import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig, ConflictError, Database, ValidationError } from '../../../shared-kernel';
import { isAllowedPushEndpoint } from '../domain/push-endpoint';
import { PushSubscriptionRepository } from './ports';

export interface NewPushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
}

/** Suscripciones Web Push (VAPID) de la PWA: el navegador las crea con la clave pública del servidor. */
@Injectable()
export class PushSubscriptionService {
  constructor(
    private readonly db: Database,
    private readonly subscriptions: PushSubscriptionRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Clave pública VAPID que usa pushManager.subscribe({ applicationServerKey }). null = Web Push deshabilitado. */
  publicKey(): { publicKey: string | null } {
    return { publicKey: this.config.notifications.vapidPublicKey };
  }

  /**
   * 422 PUSH_ENDPOINT_NOT_ALLOWED si el endpoint no es de un servicio push conocido (SSRF).
   * 409 PUSH_ENDPOINT_TAKEN si el endpoint ya es de otro usuario: no se reasigna (un endpoint
   * ajeno filtrado no sirve para quedarse con las notificaciones de otro).
   */
  async subscribe(userId: string, s: NewPushSubscription): Promise<{ id: string }> {
    if (!isAllowedPushEndpoint(s.endpoint, this.config.notifications.webPushAllowedHosts)) {
      throw new ValidationError('PUSH_ENDPOINT_NOT_ALLOWED', 'El endpoint no es de un servicio push reconocido');
    }
    const id = await this.subscriptions.upsert(this.db, { userId, ...s });
    if (!id) throw new ConflictError('PUSH_ENDPOINT_TAKEN', 'La suscripción pertenece a otra cuenta; bórrala en el navegador y vuelve a suscribirte');
    return { id };
  }

  /** Idempotente: borrar una suscripción que no existe (o de otro usuario) no falla. */
  async unsubscribe(userId: string, endpoint: string): Promise<void> {
    await this.subscriptions.deleteByEndpoint(this.db, endpoint, userId);
  }
}
