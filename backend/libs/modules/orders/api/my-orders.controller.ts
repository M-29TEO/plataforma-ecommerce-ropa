import { Body, Controller, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Audited, Auth, AuthUser, CurrentUser } from '../../../shared-kernel';
import { OrderService } from '../application/order.service';
import { CancelMyOrderDto, MyOrdersQuery } from './dto/order.dto';

function assertCustomer(user: AuthUser): void {
  if (user.type !== 'customer') throw new ForbiddenException('Solo para clientes');
}

/**
 * "Mis pedidos": el cliente solo ve y cancela los suyos. Un pedido ajeno responde 404
 * (no se revela que existe).
 */
@Controller('me/orders')
export class MyOrdersController {
  constructor(private readonly orders: OrderService) {}

  @Get()
  @Auth()
  list(@CurrentUser() user: AuthUser, @Query() q: MyOrdersQuery) {
    assertCustomer(user);
    return this.orders.list(user.tenantId, { userId: user.id, statuses: q.status, limit: q.limit, offset: q.offset });
  }

  @Get(':id')
  @Auth()
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    assertCustomer(user);
    return this.orders.get(user.tenantId, id, user.id);
  }

  /** Solo antes de que el pedido entre a preparación (created o paid); lo decide el dominio. */
  @Post(':id/cancel')
  @HttpCode(200)
  @Auth()
  @Audited('orders.order.cancel', { entity: 'order' })
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelMyOrderDto) {
    assertCustomer(user);
    return this.orders.changeStatus(user.tenantId, id, {
      to: 'cancelled',
      expectedVersion: dto.version,
      reason: dto.reason,
      ownerId: user.id,
      actor: { type: 'customer', id: user.id },
    });
  }
}
