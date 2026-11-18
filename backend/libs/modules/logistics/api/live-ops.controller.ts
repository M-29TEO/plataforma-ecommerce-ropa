import { Body, Controller, ForbiddenException, Get, HttpCode, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePermission } from '../../../shared-kernel';
import { LiveOpsService } from '../application/live-ops.service';
import { ListShipmentsQuery, RiderPresenceDto } from './dto/live-ops.dto';

/** Backoffice: mapa en vivo de la flota (los cambios llegan luego por Socket.IO, namespace /staff). */
@Controller('logistics/riders')
export class LiveRidersController {
  constructor(private readonly live: LiveOpsService) {}

  /** Motorizados no inactivos con su última posición (24 h) y sus envíos en curso. */
  @Get('live')
  @RequirePermission('logistics.read')
  riders(@CurrentUser() user: AuthUser) {
    return this.live.liveRiders(user.tenantId);
  }
}

/** Backoffice: cola de despacho y listado de envíos (la asignación está en DispatchController). */
@Controller('logistics/shipments')
export class ShipmentsListController {
  constructor(private readonly live: LiveOpsService) {}

  @Get()
  @RequirePermission('logistics.read')
  list(@CurrentUser() user: AuthUser, @Query() q: ListShipmentsQuery) {
    return this.live.listShipments(user.tenantId, {
      statuses: q.status,
      carrierType: q.carrierType,
      zoneId: q.zoneId,
      riderId: q.riderId,
      limit: q.limit,
      offset: q.offset,
    });
  }
}

/** App del motorizado: su presencia (disponible / pausa / desconectado). */
@Controller('rider')
export class RiderPresenceController {
  constructor(private readonly live: LiveOpsService) {}

  @Post('presence')
  @HttpCode(200)
  presence(@CurrentUser() user: AuthUser, @Body() dto: RiderPresenceDto) {
    if (user.type !== 'rider') throw new ForbiddenException('Solo para motorizados');
    return this.live.setPresence(user.tenantId, user.id, dto.presence);
  }
}
