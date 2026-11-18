import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Audited, Auth, AuthUser, CurrentUser, Public } from '../../../shared-kernel';
import { NotificationsApi } from '../application/notifications.api';
import { NotificationView } from '../application/ports';
import { PushSubscriptionService } from '../application/push-subscription.service';
import { TemplateAdminService } from '../application/template-admin.service';
import {
  ListNotificationsQuery,
  PageQuery,
  PushSubscriptionDto,
  PushUnsubscribeDto,
  TemplateParams,
  UpsertTemplateDto,
} from './dto/notifications.dto';

/**
 * Enlaces firmados (ticket de invitado: payload.firma en base64url) dentro del texto enviado. Son
 * credenciales del destinatario: el staff que revisa la bandeja no debe poder usarlos.
 */
const SIGNED_TOKEN = /[A-Za-z0-9_-]{16,}.[A-Za-z0-9_-]{16,}/g;

function forStaff(n: NotificationView): NotificationView {
  return { ...n, text: n.text?.replace(SIGNED_TOKEN, '[enlace firmado oculto]') ?? null };
}

/** Lo que ve el destinatario: sin el detalle técnico del último error de envío. */
function forRecipient(n: NotificationView): Omit<NotificationView, 'error' | 'attempts'> {
  const { error: _error, attempts: _attempts, ...rest } = n;
  return rest;
}

/** Clave pública VAPID (pública por definición: la necesita el navegador para suscribirse). */
@Controller('notifications/push')
@Public()
export class PushKeyController {
  constructor(private readonly push: PushSubscriptionService) {}

  @Get('public-key')
  publicKey() {
    return this.push.publicKey();
  }
}

/** Suscripciones Web Push del usuario autenticado (cliente en la PWA, motorizado o staff). */
@Controller('me/push-subscriptions')
export class MyPushSubscriptionsController {
  constructor(private readonly push: PushSubscriptionService) {}

  @Post()
  @Auth()
  subscribe(@CurrentUser() user: AuthUser, @Body() body: PushSubscriptionDto, @Req() req: Request) {
    const ua = req.headers['user-agent'];
    return this.push.subscribe(user.id, {
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      userAgent: typeof ua === 'string' ? ua.slice(0, 300) : null,
    });
  }

  @Delete()
  @HttpCode(204)
  @Auth()
  async unsubscribe(@CurrentUser() user: AuthUser, @Body() body: PushUnsubscribeDto) {
    await this.push.unsubscribe(user.id, body.endpoint);
  }
}

/** "Mis notificaciones": lo que se le envió al usuario (sin los suprimidos ni los fallidos). */
@Controller('me/notifications')
export class MyNotificationsController {
  constructor(private readonly notifications: NotificationsApi) {}

  @Get()
  @Auth()
  async list(@CurrentUser() user: AuthUser, @Query() q: PageQuery) {
    const items = await this.notifications.list(user.tenantId, { userId: user.id, statuses: ['queued', 'sent', 'delivered', 'read'], limit: q.limit, offset: q.offset });
    return items.map(forRecipient);
  }
}

/** Backoffice: bandeja de envíos (para revisar fallidos y suprimidos) y plantillas del tenant. */
@Controller('notifications')
export class NotificationsAdminController {
  constructor(
    private readonly notifications: NotificationsApi,
    private readonly templates: TemplateAdminService,
  ) {}

  @Get()
  @Auth('notifications.read')
  async list(@CurrentUser() user: AuthUser, @Query() q: ListNotificationsQuery) {
    const items = await this.notifications.list(user.tenantId, {
      userId: q.userId,
      statuses: q.status,
      channel: q.channel,
      templateCode: q.templateCode,
      limit: q.limit,
      offset: q.offset,
    });
    return items.map(forStaff);
  }

  @Get('templates')
  @Auth('notifications.read')
  catalog(@CurrentUser() user: AuthUser) {
    return this.templates.catalog(user.tenantId);
  }

  /** PUT /notifications/templates/order.placed/email/es-EC · active=false apaga ese mensaje por ese canal e idioma. */
  @Put('templates/:code/:channel/:locale')
  @Auth('notifications.templates.write')
  @Audited('notifications.template.upsert', { entity: 'notification_template', idParam: 'code' })
  upsert(@CurrentUser() user: AuthUser, @Param() p: TemplateParams, @Body() body: UpsertTemplateDto) {
    return this.templates.upsert(user.tenantId, p.code, p.channel, p.locale, { subject: body.subject ?? null, body: body.body, active: body.active });
  }
}
