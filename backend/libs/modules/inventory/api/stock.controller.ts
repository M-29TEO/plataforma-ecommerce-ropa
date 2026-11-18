import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Audited, Auth, AuthUser, CurrentUser, ValidationError } from '../../../shared-kernel';
import { ReservationService } from '../application/reservation.service';
import { AdjustStockInput, StockService } from '../application/stock.service';
import {
  AdjustStockDto,
  ListMovementsQuery,
  ListReservationsQuery,
  ListStockQuery,
  UpdateStockSettingsDto,
} from './dto/stock.dto';

@Controller('inventory')
export class StockController {
  constructor(
    private readonly stock: StockService,
    private readonly reservations: ReservationService,
  ) {}

  /** Stock de una bodega (con filtro de bajo punto de reorden) o de una variante en todas las bodegas. */
  @Get('stock')
  @Auth('inventory.read')
  list(@CurrentUser() user: AuthUser, @Query() q: ListStockQuery) {
    if (q.warehouseId && q.variantId) return this.stock.getLevel(user.tenantId, q.variantId, q.warehouseId).then((l) => [l]);
    if (q.warehouseId) {
      return this.stock.listByWarehouse(user.tenantId, q.warehouseId, {
        belowReorderPoint: q.belowReorderPoint,
        limit: q.limit,
        offset: q.offset,
      });
    }
    if (q.variantId) return this.stock.listByVariant(user.tenantId, q.variantId);
    throw new ValidationError('FILTER_REQUIRED', 'Indica warehouseId, variantId o ambos');
  }

  @Get('stock/movements')
  @Auth('inventory.read')
  movements(@CurrentUser() user: AuthUser, @Query() q: ListMovementsQuery) {
    return this.stock.listMovements(user.tenantId, q);
  }

  @Get('stock/:variantId/:warehouseId')
  @Auth('inventory.read')
  get(
    @CurrentUser() user: AuthUser,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Param('warehouseId', ParseUUIDPipe) warehouseId: string,
  ) {
    return this.stock.getLevel(user.tenantId, variantId, warehouseId);
  }

  @Patch('stock/:variantId/:warehouseId')
  @Auth('inventory.stock.write')
  @Audited('inventory.stock.settings.update', { entity: 'stock', idParam: 'variantId' })
  updateSettings(
    @CurrentUser() user: AuthUser,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Param('warehouseId', ParseUUIDPipe) warehouseId: string,
    @Body() dto: UpdateStockSettingsDto,
  ) {
    const { version, ...patch } = dto;
    return this.stock.updateSettings(user.tenantId, variantId, warehouseId, version, patch);
  }

  /** Ajuste manual: exige el permiso granular inventory.adjust y queda en el ledger con el usuario. */
  @Post('stock/adjustments')
  @Auth('inventory.adjust')
  @Audited('inventory.stock.adjust', { entity: 'stock' })
  adjust(@CurrentUser() user: AuthUser, @Body() dto: AdjustStockDto) {
    return this.stock.adjust(user.tenantId, user.id, toAdjustInput(dto));
  }

  @Get('reservations')
  @Auth('inventory.read')
  reservationsByOrder(@CurrentUser() user: AuthUser, @Query() q: ListReservationsQuery) {
    return this.reservations.listByOrder(user.tenantId, q.orderId);
  }
}

function toAdjustInput(dto: AdjustStockDto): AdjustStockInput {
  const base = { variantId: dto.variantId, warehouseId: dto.warehouseId, reason: dto.reason };
  switch (dto.type) {
    case 'adjustment':
      return { ...base, type: 'adjustment', delta: dto.delta! };
    case 'damage':
      return { ...base, type: 'damage', quantity: dto.quantity! };
    case 'count':
      return { ...base, type: 'count', countedQuantity: dto.countedQuantity! };
  }
}
