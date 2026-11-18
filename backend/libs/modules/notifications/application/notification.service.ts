import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig, Database } from '../../../shared-kernel';
import { IamApi } from '../../iam';
import { catalogEntry, TemplateCode } from '../domain/catalog';
import { Channel, MARKETING_PURPOSE } from '../domain/channel';
import { DEFAULT_LOCALE } from '../domain/locale';
import { dedupeKey, isMobile, normalizeEmail, toE164 } from '../domain/recipients';
import { NotificationRepository, PushSubscriptionRepository, TemplateEngine } from './ports';

/** A quién se le escribe: un cliente (datos del pedido o del carrito, completados con IAM) o el backoffice. */
export type Audience =
  | {
      kind: 'customer';
      userId?: string | null;
      email?: string | null;
      phone?: string | null;
      name?: string | null;
    }
  | { kind: 'staff' };

export interface NotifyRequest {
  tenantId: string;
  templateCode: TemplateCode;
  /** Id de lo que origina el mensaje (pedido, envío, comprobante, carrito+etapa): parte de la dedupe_key. */
  sourceId: string;
  to: Audience;
  data: Record<string, unknown>;
  /** Por defecto, los canales del catálogo. */
  channels?: readonly Channel[];
}

export interface NotifyResult {
  queued: number;
  suppressed: number;
  /** Ya existían (evento repetido): la dedupe_key evitó el duplicado. */
  duplicates: number;
}

interface Recipient {
  address: string;
  /** Web Push: id de la suscripción (las claves se leen al enviar, por si cambian). */
  subscriptionId?: string;
}

/**
 * Encola notificaciones (fase 1 de 2). Corre DENTRO de la transacción del consumidor (la del relay
 * del outbox): si el handler falla, no queda ninguna fila; si el evento se repite, la dedupe_key
 * (UNIQUE tenant_id, dedupe_key) evita el duplicado. No envía nada: lo hace el despachador, fuera
 * de la transacción, con reintentos.
 *
 * Por cada canal: destinatarios → plantilla del idioma del usuario → consentimiento (solo
 * marketing) → render → fila 'queued' o 'suppressed' (sin consentimiento, queda como evidencia).
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly db: Database,
    private readonly notifications: NotificationRepository,
    private readonly subscriptions: PushSubscriptionRepository,
    private readonly templates: TemplateEngine,
    private readonly iam: IamApi,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async notify(req: NotifyRequest): Promise<NotifyResult> {
    const result: NotifyResult = { queued: 0, suppressed: 0, duplicates: 0 };
    const entry = catalogEntry(req.templateCode);
    const marketing = entry.category === 'marketing';
    const contact = await this.contact(req);
    if (!contact) return result;

    for (const channel of req.channels ?? entry.channels) {
      const recipients = await this.recipients(channel, req.to, contact);
      if (recipients.length === 0) continue;

      const template = await this.templates.resolve(this.db, req.tenantId, req.templateCode, channel, contact.locale);
      if (!template) continue;

      let suppression: string | null = null;
      if (marketing) {
        const purpose = MARKETING_PURPOSE[channel];
        if (!purpose) suppression = `El canal ${channel} no admite marketing`;
        else if (!(await this.iam.hasConsent(req.tenantId, { userId: contact.userId, email: contact.email }, purpose))) {
          suppression = `Sin consentimiento ${purpose}`;
        }
      }

      const data = {
        brand: this.config.notifications.brandName,
        storefrontUrl: this.config.notifications.storefrontUrl,
        name: contact.name,
        ...req.data,
      };
      const content = this.templates.render(template, data, { marketing });
      const url = typeof req.data.url === 'string' ? req.data.url : null;

      for (const r of recipients) {
        const inserted = await this.notifications.insert(this.db, {
          tenantId: req.tenantId,
          userId: contact.userId,
          channel,
          templateCode: req.templateCode,
          recipient: r.address,
          payload: {
            subject: content.subject,
            text: content.text,
            html: content.html,
            url,
            locale: template.locale,
            templateSource: template.source,
            category: entry.category,
            ...(r.subscriptionId ? { subscriptionId: r.subscriptionId } : {}),
          },
          status: suppression ? 'suppressed' : 'queued',
          error: suppression,
          dedupeKey: dedupeKey(req.templateCode, req.sourceId, channel, r.subscriptionId ?? r.address),
        });
        if (!inserted) result.duplicates++;
        else if (suppression) result.suppressed++;
        else result.queued++;
      }
    }
    return result;
  }

  /** Datos del destinatario: lo que trae el evento, completado con IAM. null = no escribirle. */
  private async contact(req: NotifyRequest): Promise<{ userId: string | null; email: string | null; phone: string | null; name: string | null; locale: string } | null> {
    if (req.to.kind === 'staff') return { userId: null, email: null, phone: null, name: null, locale: DEFAULT_LOCALE };
    const to = req.to;
    let user = null;
    if (to.userId) {
      user = await this.iam.getContact(req.tenantId, to.userId);
      // Usuario anonimizado o borrado (derecho de supresión, LOPDP): no se le escribe por ningún canal.
      if (!user) {
        this.logger.debug(`Usuario ${to.userId} sin datos de contacto: no se notifica ${req.templateCode}`);
        return null;
      }
    }
    return {
      userId: user?.userId ?? null,
      email: normalizeEmail(to.email) ?? normalizeEmail(user?.email),
      phone: to.phone || user?.phone || null,
      name: to.name || user?.firstName || null,
      locale: user?.locale || DEFAULT_LOCALE,
    };
  }

  private async recipients(channel: Channel, to: Audience, contact: { userId: string | null; email: string | null; phone: string | null }): Promise<Recipient[]> {
    if (channel === 'ntfy') return to.kind === 'staff' ? [{ address: this.config.notifications.ntfyStaffTopic }] : [];
    if (to.kind === 'staff') return [];
    switch (channel) {
      case 'email':
        return contact.email ? [{ address: contact.email }] : [];
      case 'whatsapp':
      case 'sms': {
        const phone = toE164(contact.phone);
        return phone && isMobile(phone) ? [{ address: phone }] : [];
      }
      case 'webpush':
        if (!contact.userId) return [];
        return (await this.subscriptions.listByUser(this.db, contact.userId)).map((s) => ({ address: s.endpoint, subscriptionId: s.id }));
    }
  }
}
