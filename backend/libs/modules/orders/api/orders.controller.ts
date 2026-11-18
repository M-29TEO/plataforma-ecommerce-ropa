import { Body, Controller, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Audited, Auth, AuthUser, CurrentUser, missingPermission } from '../../../shared-kernel';
import { OrderService } from '../application/order.service';
import { ManualOrderStatus } from '../domain/order-status';
import { ChangeStatusDto, ListOrdersQuery } from './dto/order.dto';

/**
 * Permiso que exige cada estado destino. Marcar pagado a mano (transferencia verificada) y
 * cancelar tienen consecuencias de dinero y stock, por eso son permisos aparte. Las devoluciones
 * (partially_returned, returned) no se fijan a mano: las registra el flujo de devoluciones.
 */
const PERMISSION_FOR: Record<ManualOrderStatus, string> = {
  created: 'orders.status.update', // no hay transición hacia created; la rechaza el dominio
  paid: 'orders.payment.confirm',
  preparing: 'orders.status.update',
  shipped: 'orders.status.update',
  in_transit: 'orders.status.update',
  delivered: 'orders.status.update',
  cancelled: 'orders.cancel',
};

/**
 * Lo único que un motorizado puede marcar: que salió a entregar y que entregó. Aunque un rol
 * personalizado le dé orders.status.update u orders.cancel, no prepara, no cancela ni confirma pagos.
 *
 * Limitación: la asignación del envío vive en Logística (logistics.shipments.rider_id) y Pedidos no
 * puede importarla (Logística ya depende de Pedidos: ciclo), así que aquí no se verifica que el
 * pedido sea de ese motorizado. Esa verificación corresponde al flujo de entrega de Logística.
 */
const RIDER_STATUSES: ReadonlySet<ManualOrderStatus> = new Set<ManualOrderStatus>(['in_transit', 'delivered']);

/** Backoffice (staff) y motorizados: listar, filtrar, ver y cambiar el estado de los pedidos. */
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrderService) {}

  @Get()
  @Auth('orders.read')
  list(@CurrentUser() user: AuthUser, @Query() q: ListOrdersQuery) {
    return this.orders.list(user.tenantId, {
      statuses: q.status,
      paymentStatus: q.paymentStatus,
      paymentMethod: q.paymentMethod,
      fulfillmentType: q.fulfillmentType,
      channel: q.channel,
      userId: q.userId,
      from: q.from,
      to: q.to,
      search: q.q,
      limit: q.limit,
      offset: q.offset,
    });
  }

  @Get(':id')
  @Auth('orders.read')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.get(user.tenantId, id);
  }

  @Get(':id/history')
  @Auth('orders.read')
  history(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.history(user.tenantId, id);
  }

  @Post(':id/status')
  @HttpCode(200)
  @Auth()
  @Audited('orders.status.change', { entity: 'order' })
  changeStatus(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ChangeStatusDto) {
    const required = PERMISSION_FOR[dto.to];
    if (!user.permissions.includes(required)) throw missingPermission([required], user);
    if (user.type === 'customer') throw new ForbiddenException('Los clientes usan /me/orders');
    if (user.type === 'rider' && !RIDER_STATUSES.has(dto.to)) {
      throw new ForbiddenException('Un motorizado solo marca pedidos en camino o entregados');
    }
    return this.orders.changeStatus(user.tenantId, id, {
      to: dto.to,
      expectedVersion: dto.version,
      reason: dto.reason,
      actor: { type: user.type, id: user.id },
    });
  }
}
