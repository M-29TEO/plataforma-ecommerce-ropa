/**
 * API PÚBLICA del módulo Notificaciones. Otros módulos solo pueden importar desde aquí.
 */
export { NotificationsConsumersModule, NotificationsModule, NotificationsWorkerModule } from './notifications.module';
export { NotificationsApi } from './application/notifications.api';
export type { Audience, NotifyRequest, NotifyResult } from './application/notification.service';
export type { DispatchRun } from './application/notification-dispatcher.service';
export type { NotificationView } from './application/ports';
export { TEMPLATE_CATALOG } from './domain/catalog';
export type { TemplateCode } from './domain/catalog';
export { CHANNELS } from './domain/channel';
export type { Channel, NotificationStatus } from './domain/channel';
