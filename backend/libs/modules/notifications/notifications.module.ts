import { Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../shared-kernel';
import { IamModule } from '../iam';
import { OrdersModule } from '../orders';
import {
  MyNotificationsController,
  MyPushSubscriptionsController,
  NotificationsAdminController,
  PushKeyController,
} from './api/notifications.controller';
import { NotificationDispatcher } from './application/notification-dispatcher.service';
import { NotificationService } from './application/notification.service';
import { NotificationsApi } from './application/notifications.api';
import { CHANNEL_PORTS, ChannelPort, NotificationRepository, PushSubscriptionRepository, TemplateEngine, TemplateRepository } from './application/ports';
import { PushSubscriptionService } from './application/push-subscription.service';
import { TemplateAdminService } from './application/template-admin.service';
import { SmtpEmailChannel } from './infrastructure/channels/email.channel';
import { InMemoryChannel } from './infrastructure/channels/in-memory.channel';
import { NtfyChannel } from './infrastructure/channels/ntfy.channel';
import { SimulatedMessagingChannel } from './infrastructure/channels/simulated.channel';
import { VapidWebPushChannel } from './infrastructure/channels/webpush.channel';
import { NotificationsConsumer } from './infrastructure/consumers/notifications.consumer';
import { DispatchNotificationsJob } from './infrastructure/jobs/dispatch-notifications.job';
import { NotificationsPersonalDataContributor } from './infrastructure/personal-data.contributor';
import { PgNotificationRepository } from './infrastructure/pg-notification.repository';
import { PgPushSubscriptionRepository } from './infrastructure/pg-push-subscription.repository';
import { PgTemplateRepository } from './infrastructure/pg-template.repository';
import { HandlebarsTemplateEngine } from './infrastructure/templates/handlebars-engine';

/** Un adaptador de ChannelPort por canal. WhatsApp y SMS son siempre simulados (log). */
export function createChannelPorts(c: AppConfig): ChannelPort[] {
  const n = c.notifications;
  const simulated = [new SimulatedMessagingChannel('whatsapp'), new SimulatedMessagingChannel('sms')];
  if (n.transport === 'memory') return [new InMemoryChannel('email'), new InMemoryChannel('webpush'), new InMemoryChannel('ntfy'), ...simulated];
  return [
    new SmtpEmailChannel(n.smtpUrl, n.mailFrom, n.sendTimeoutMs),
    new VapidWebPushChannel({ publicKey: n.vapidPublicKey, privateKey: n.vapidPrivateKey, subject: n.vapidSubject }, n.sendTimeoutMs, n.webPushAllowedHosts),
    new NtfyChannel(n.ntfyUrl, n.ntfyToken, n.sendTimeoutMs),
    ...simulated,
  ];
}

/**
 * Módulo Notificaciones (schema platform: notification_templates, notifications,
 * push_subscriptions). Plantillas Handlebars por canal e idioma, consentimientos de marketing por
 * la API de IAM, deduplicación por dedupe_key y envío en dos fases: encolar (en la transacción del
 * evento) y despachar (job del worker, con reintentos). Lee los pedidos por la API de Pedidos.
 */
@Module({
  imports: [IamModule, OrdersModule],
  controllers: [PushKeyController, MyPushSubscriptionsController, MyNotificationsController, NotificationsAdminController],
  providers: [
    { provide: NotificationRepository, useClass: PgNotificationRepository },
    { provide: TemplateRepository, useClass: PgTemplateRepository },
    { provide: PushSubscriptionRepository, useClass: PgPushSubscriptionRepository },
    { provide: TemplateEngine, useClass: HandlebarsTemplateEngine },
    { provide: CHANNEL_PORTS, inject: [APP_CONFIG], useFactory: createChannelPorts },
    NotificationService,
    NotificationDispatcher,
    PushSubscriptionService,
    TemplateAdminService,
    NotificationsApi,
    NotificationsPersonalDataContributor,
  ],
  exports: [NotificationsApi, NotificationService, NotificationDispatcher, CHANNEL_PORTS],
})
export class NotificationsModule {}

/** Consumidores de eventos de otros módulos (proceso worker; en tests, junto con el relay). */
@Module({ imports: [NotificationsModule, OrdersModule], providers: [NotificationsConsumer] })
export class NotificationsConsumersModule {}

/** Jobs del proceso worker (despachador de la cola). Requiere QueueModule. */
@Module({ imports: [NotificationsModule], providers: [DispatchNotificationsJob] })
export class NotificationsWorkerModule {}
