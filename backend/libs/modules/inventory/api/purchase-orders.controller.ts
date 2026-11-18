import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Audited, Auth, AuthUser, CurrentUser } from '../../../shared-kernel';
import { PurchaseOrderService } from '../application/purchase-order.service';
import { CreatePurchaseOrderDto, ListPurchaseOrdersQuery, ReceivePurchaseOrderDto } from './dto/purchase-order.dto';

@Controller('inventory/purchase-orders')
export class PurchaseOrdersController {
  constructor(private readonly orders: PurchaseOrderService) {}

  @Post()
  @Auth('inventory.purchase.write')
  @Audited('inventory.purchase_order.create', { entity: 'purchase_order' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreatePurchaseOrderDto) {
    return this.orders.create(user.tenantId, user.id, dto);
  }

  @Get()
  @Auth('inventory.read')
  list(@CurrentUser() user: AuthUser, @Query() q: ListPurchaseOrdersQuery) {
    return this.orders.list(user.tenantId, q);
  }

  @Get(':id')
  @Auth('inventory.read')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.get(user.tenantId, id);
  }

  @Post(':id/send')
  @HttpCode(200)
  @Auth('inventory.purchase.write')
  @Audited('inventory.purchase_order.send', { entity: 'purchase_order' })
  send(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.send(user.tenantId, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Auth('inventory.purchase.write')
  @Audited('inventory.purchase_order.cancel', { entity: 'purchase_order' })
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.cancel(user.tenantId, id);
  }

  /** Recepción total o parcial; se puede llamar varias veces hasta completar la orden. */
  @Post(':id/receipts')
  @HttpCode(200)
  @Auth('inventory.purchase.receive')
  @Audited('inventory.purchase_order.receive', { entity: 'purchase_order' })
  receive(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReceivePurchaseOrderDto) {
    return this.orders.receive(user.tenantId, user.id, id, dto);
  }
}
