import { Body, Controller, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Audited, Auth, AuthUser, CurrentUser } from '../../../shared-kernel';
import { PickingService } from '../application/picking.service';
import { CompletePickingDto, PickingQueueQuery, StartPickingDto } from './dto/picking.dto';

/** Solo personal (bodega, admin): un token de cliente o motorizado no prepara pedidos. */
function staffActor(user: AuthUser) {
  if (user.type !== 'staff') throw new ForbiddenException('Solo el personal de bodega prepara pedidos');
  return { type: 'staff' as const, id: user.id };
}

/**
 * Picking de bodega (app backoffice): cola de pedidos por preparar, detalle con códigos de barras,
 * inicio (pedido → preparing) y cierre (envío → ready_for_pickup). Un pedido de otro tenant: 404.
 */
@Controller('fulfillment/picking')
export class PickingController {
  constructor(private readonly picking: PickingService) {}

  @Get()
  @Auth('inventory.picking')
  queue(@CurrentUser() user: AuthUser, @Query() q: PickingQueueQuery) {
    staffActor(user);
    return this.picking.queue(user.tenantId, { warehouseId: q.warehouseId, state: q.state, limit: q.limit, offset: q.offset });
  }

  @Get(':orderId')
  @Auth('inventory.picking')
  detail(@CurrentUser() user: AuthUser, @Param('orderId', ParseUUIDPipe) orderId: string) {
    staffActor(user);
    return this.picking.detail(user.tenantId, orderId);
  }

  @Post(':orderId/start')
  @HttpCode(200)
  @Auth('inventory.picking')
  @Audited('fulfillment.picking.started', { entity: 'order', idParam: 'orderId' })
  start(@CurrentUser() user: AuthUser, @Param('orderId', ParseUUIDPipe) orderId: string, @Body() dto: StartPickingDto) {
    return this.picking.start(user.tenantId, orderId, dto.version, staffActor(user));
  }

  @Post(':orderId/complete')
  @HttpCode(200)
  @Auth('inventory.picking')
  @Audited('fulfillment.picking.completed', { entity: 'order', idParam: 'orderId' })
  complete(@CurrentUser() user: AuthUser, @Param('orderId', ParseUUIDPipe) orderId: string, @Body() dto: CompletePickingDto) {
    staffActor(user);
    return this.picking.complete(user.tenantId, orderId, dto.items);
  }
}
