import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Audited, Auth, AuthUser, CurrentUser } from '../../../shared-kernel';
import { WarehouseService } from '../application/warehouse.service';
import { CreateWarehouseDto, ListWarehousesQuery, NearbyWarehousesQuery, UpdateWarehouseDto } from './dto/warehouse.dto';

@Controller('inventory/warehouses')
export class WarehousesController {
  constructor(private readonly warehouses: WarehouseService) {}

  @Post()
  @Auth('inventory.warehouse.write')
  @Audited('inventory.warehouse.create', { entity: 'warehouse' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateWarehouseDto) {
    // La dirección se guarda como jsonb: objeto plano con las claves validadas por el DTO.
    return this.warehouses.create(user.tenantId, { ...dto, address: { ...dto.address } });
  }

  @Get()
  @Auth('inventory.read')
  list(@CurrentUser() user: AuthUser, @Query() query: ListWarehousesQuery) {
    return this.warehouses.list(user.tenantId, query);
  }

  /** Declarada antes de ':id' para que "nearby" no se interprete como un id. */
  @Get('nearby')
  @Auth('inventory.read')
  nearby(@CurrentUser() user: AuthUser, @Query() query: NearbyWarehousesQuery) {
    return this.warehouses.nearby(user.tenantId, { lat: query.lat, lng: query.lng }, query.radiusKm, query.limit);
  }

  @Get(':id')
  @Auth('inventory.read')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.warehouses.get(user.tenantId, id);
  }

  @Patch(':id')
  @Auth('inventory.warehouse.write')
  @Audited('inventory.warehouse.update', { entity: 'warehouse' })
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateWarehouseDto) {
    const { address, ...rest } = dto;
    return this.warehouses.update(user.tenantId, id, address ? { ...rest, address: { ...address } } : rest);
  }

  /** Borrado lógico (active = false). */
  @Delete(':id')
  @Auth('inventory.warehouse.write')
  @Audited('inventory.warehouse.deactivate', { entity: 'warehouse' })
  deactivate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.warehouses.deactivate(user.tenantId, id);
  }
}
