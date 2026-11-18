/** Puertos del módulo Notificaciones (schema platform: notification_templates, notifications, push_subscriptions). */
import { Queryable } from '../../../shared-kernel';
import { Channel, NotificationStatus, TemplateCategory } from '../domain/channel';

// ---------------------------------------------------------------- Canales (ChannelPort)

/** Mensaje ya renderizado, listo para un canal. */
export interface OutgoingMessage {
  notificationId: string;
  channel: Channel;
  /** Email, teléfono E.164, endpoint de Web Push o tópico de ntfy. */
  recipient: string;
  /** Asunto (email) o título (Web Push, ntfy). */
  subject: string | null;
  /** Texto plano (WhatsApp, SMS, push, ntfy y alternativa de texto del email). */
  text: string;
  /** Solo email. */
  html: string | null;
  /** Enlace al que lleva el mensaje (clic en el push o en ntfy). */
  url: string | null;
  /** Solo Web Push: claves de la suscripción del navegador. */
  push?: { endpoint: string; p256dh: string; auth: string };
}

export interface SendResult {
  providerMsgId: string | null;
}

/**
 * Error de un canal. permanent: no tiene sentido reintentar (destinatario inválido, 4xx).
 * gone: la suscripción de Web Push ya no existe (404/410) y hay que borrarla.
 */
export class ChannelSendError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    readonly gone = false,
  ) {
    super(message);
    this.name = 'ChannelSendError';
  }
}

/** Puerto de salida de un canal (arquitectura hexagonal): SMTP, Web Push, ntfy, WhatsApp y SMS simulados. */
export abstract class ChannelPort {
  abstract readonly channel: Channel;
  abstract send(message: OutgoingMessage): Promise<SendResult>;
}

/** Los adaptadores activos, uno por canal (los arma el módulo según NOTIFICATION_TRANSPORT). */
export const CHANNEL_PORTS = Symbol('CHANNEL_PORTS');

// ---------------------------------------------------------------- Plantillas

export interface StoredTemplate {
  id: string;
  code: string;
  channel: Channel;
  locale: string;
  subject: string | null;
  body: string;
  category: TemplateCategory;
  active: boolean;
}

export abstract class TemplateRepository {
  /** Plantilla propia del tenant (activa o no), o null. */
  abstract find(q: Queryable, tenantId: string, code: string, channel: Channel, locale: string): Promise<StoredTemplate | null>;
  abstract listForTenant(q: Queryable, tenantId: string): Promise<StoredTemplate[]>;
  abstract upsert(q: Queryable, tenantId: string, t: Omit<StoredTemplate, 'id'>): Promise<StoredTemplate>;
}

/** Plantilla elegida para un envío: la del tenant o la que trae el sistema. */
export interface ResolvedTemplate {
  code: string;
  channel: Channel;
  locale: string;
  subject: string | null;
  body: string;
  source: 'tenant' | 'default';
}

export interface RenderedContent {
  subject: string | null;
  text: string;
  html: string | null;
}

/** Motor de plantillas (Handlebars): busca la plantilla y la renderiza con los datos del mensaje. */
export abstract class TemplateEngine {
  abstract resolve(q: Queryable, tenantId: string, code: string, channel: Channel, locale: string | null): Promise<ResolvedTemplate | null>;
  abstract render(t: ResolvedTemplate, data: Record<string, unknown>, opts: { marketing: boolean }): RenderedContent;
  /** Lanza ValidationError si el texto no compila. */
  abstract validate(source: string): void;
}

// ---------------------------------------------------------------- Notificaciones

export interface NewNotification {
  tenantId: string;
  userId: string | null;
  channel: Channel;
  templateCode: string;
  recipient: string;
  payload: Record<string, unknown>;
  status: 'queued' | 'suppressed';
  error: string | null;
  dedupeKey: string;
}

export interface QueuedNotification {
  id: string;
  tenantId: string;
  userId: string | null;
  channel: Channel;
  templateCode: string;
  recipient: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface NotificationView {
  id: string;
  userId: string | null;
  channel: Channel;
  templateCode: string;
  recipient: string;
  status: NotificationStatus;
  subject: string | null;
  text: string | null;
  attempts: number;
  error: string | null;
  createdAt: Date;
  sentAt: Date | null;
}

export interface NotificationFilter {
  userId?: string;
  statuses?: NotificationStatus[];
  channel?: Channel;
  templateCode?: string;
  limit: number;
  offset: number;
}

export abstract class NotificationRepository {
  /** INSERT … ON CONFLICT (tenant_id, dedupe_key) DO NOTHING. false si ya existía. */
  abstract insert(q: Queryable, n: NewNotification): Promise<boolean>;
  /**
   * Toma hasta `limit` notificaciones 'queued' vencidas (SKIP LOCKED) y les corre next_attempt_at
   * `leaseSeconds` hacia adelante: otra réplica no las toma mientras se envían.
   */
  abstract claimDue(q: Queryable, now: Date, limit: number, leaseSeconds: number, tenantId?: string): Promise<QueuedNotification[]>;
  abstract markSent(q: Queryable, id: string, providerMsgId: string | null, attempts: number, now: Date): Promise<void>;
  abstract markRetry(q: Queryable, id: string, attempts: number, nextAttemptAt: Date, error: string): Promise<void>;
  abstract markFailed(q: Queryable, id: string, attempts: number, error: string): Promise<void>;
  abstract list(q: Queryable, tenantId: string, filter: NotificationFilter): Promise<NotificationView[]>;
}

// ---------------------------------------------------------------- Web Push

export interface PushSubscriptionRecord {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export abstract class PushSubscriptionRepository {
  /** Upsert por endpoint del MISMO usuario; null si el endpoint ya es de otro usuario (no se reasigna). */
  abstract upsert(q: Queryable, s: Omit<PushSubscriptionRecord, 'id'> & { userAgent: string | null }): Promise<string | null>;
  abstract listByUser(q: Queryable, userId: string): Promise<PushSubscriptionRecord[]>;
  abstract findById(q: Queryable, id: string): Promise<PushSubscriptionRecord | null>;
  /** userId: solo si es del usuario (baja desde "mi cuenta"); sin userId, baja por 404/410 del servicio push. */
  abstract deleteByEndpoint(q: Queryable, endpoint: string, userId?: string): Promise<boolean>;
}
