import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Audited, Auth, AuthUser, CurrentUser } from '../../../shared-kernel';
import { SupplierService } from '../application/supplier.service';
import { CreateSupplierDto, ListSuppliersQuery, UpdateSupplierDto } from './dto/supplier.dto';

@Controller('inventory/suppliers')
export class SuppliersController {
  constructor(private readonly suppliers: SupplierService) {}

  @Post()
  @Auth('inventory.supplier.write')
  @Audited('inventory.supplier.create', { entity: 'supplier' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateSupplierDto) {
    return this.suppliers.create(user.tenantId, dto);
  }

  @Get()
  @Auth('inventory.read')
  list(@CurrentUser() user: AuthUser, @Query() q: ListSuppliersQuery) {
    return this.suppliers.list(user.tenantId, q);
  }

  @Get(':id')
  @Auth('inventory.read')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.suppliers.get(user.tenantId, id);
  }

  /** Incluye active=false para desactivar (los proveedores no se borran: tienen órdenes históricas). */
  @Patch(':id')
  @Auth('inventory.supplier.write')
  @Audited('inventory.supplier.update', { entity: 'supplier' })
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSupplierDto) {
    return this.suppliers.update(user.tenantId, id, dto);
  }
}
