import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Audited, Auth, AuthUser, CurrentUser } from '../../../shared-kernel';
import { DeliveryQuoteService } from '../application/delivery-quote.service';
import { SlotService } from '../application/slot.service';
import { ZoneService } from '../application/zone.service';
import {
  CreateSlotTemplateDto,
  CreateZoneDto,
  ListSlotsQuery,
  ListZonesQuery,
  PointQuery,
  StaffQuoteDto,
  UpdateSlotCapacityDto,
  UpdateSlotTemplateDto,
  UpdateZoneDto,
} from './dto/logistics.dto';

@Controller('logistics/zones')
export class ZonesController {
  constructor(private readonly zones: ZoneService) {}

  @Post()
  @Auth('logistics.zone.write')
  @Audited('logistics.zone.create', { entity: 'zone' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateZoneDto) {
    return this.zones.create(user.tenantId, dto);
  }

  @Get()
  @Auth('logistics.read')
  list(@CurrentUser() user: AuthUser, @Query() query: ListZonesQuery) {
    return this.zones.list(user.tenantId, query);
  }

  /** ZoneResolver: qué zona cubre un punto (null si ninguna). Antes de ':id'. */
  @Get('resolve')
  @Auth('logistics.read')
  async resolve(@CurrentUser() user: AuthUser, @Query() query: PointQuery) {
    return { zone: await this.zones.resolve(user.tenantId, { lat: query.lat, lng: query.lng }) };
  }

  @Get(':id')
  @Auth('logistics.read')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.zones.get(user.tenantId, id);
  }

  @Patch(':id')
  @Auth('logistics.zone.write')
  @Audited('logistics.zone.update', { entity: 'zone' })
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateZoneDto) {
    return this.zones.update(user.tenantId, id, dto);
  }

  /** Borrado lógico (active = false). */
  @Delete(':id')
  @Auth('logistics.zone.write')
  @Audited('logistics.zone.deactivate', { entity: 'zone' })
  deactivate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.zones.deactivate(user.tenantId, id);
  }
}

@Controller('logistics/zones/:zoneId')
export class ZoneSlotsController {
  constructor(private readonly slots: SlotService) {}

  @Get('slot-templates')
  @Auth('logistics.read')
  listTemplates(@CurrentUser() user: AuthUser, @Param('zoneId', ParseUUIDPipe) zoneId: string) {
    return this.slots.listTemplates(user.tenantId, zoneId);
  }

  @Post('slot-templates')
  @Auth('logistics.zone.write')
  @Audited('logistics.slot_template.create', { entity: 'slot_template' })
  createTemplate(@CurrentUser() user: AuthUser, @Param('zoneId', ParseUUIDPipe) zoneId: string, @Body() dto: CreateSlotTemplateDto) {
    return this.slots.createTemplate(user.tenantId, zoneId, dto);
  }

  @Patch('slot-templates/:id')
  @Auth('logistics.zone.write')
  @Audited('logistics.slot_template.update', { entity: 'slot_template' })
  updateTemplate(
    @CurrentUser() user: AuthUser,
    @Param('zoneId', ParseUUIDPipe) zoneId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSlotTemplateDto,
  ) {
    return this.slots.updateTemplate(user.tenantId, zoneId, id, dto);
  }

  @Delete('slot-templates/:id')
  @Auth('logistics.zone.write')
  @HttpCode(204)
  @Audited('logistics.slot_template.delete', { entity: 'slot_template' })
  async deleteTemplate(@CurrentUser() user: AuthUser, @Param('zoneId', ParseUUIDPipe) zoneId: string, @Param('id', ParseUUIDPipe) id: string) {
    await this.slots.deleteTemplate(user.tenantId, zoneId, id);
  }

  @Get('slots')
  @Auth('logistics.read')
  listSlots(@CurrentUser() user: AuthUser, @Param('zoneId', ParseUUIDPipe) zoneId: string, @Query() query: ListSlotsQuery) {
    return this.slots.listSlots(user.tenantId, zoneId, query.from, query.to);
  }

  @Post('slots/generate')
  @Auth('logistics.zone.write')
  @HttpCode(200)
  @Audited('logistics.slots.generate', { entity: 'zone', idParam: 'zoneId' })
  generate(@CurrentUser() user: AuthUser, @Param('zoneId', ParseUUIDPipe) zoneId: string) {
    return this.slots.generateForZone(user.tenantId, zoneId);
  }

  @Patch('slots/:slotId')
  @Auth('logistics.zone.write')
  @Audited('logistics.slot.capacity.update', { entity: 'slot', idParam: 'slotId' })
  updateCapacity(
    @CurrentUser() user: AuthUser,
    @Param('zoneId', ParseUUIDPipe) zoneId: string,
    @Param('slotId', ParseUUIDPipe) slotId: string,
    @Body() dto: UpdateSlotCapacityDto,
  ) {
    return this.slots.updateCapacity(user.tenantId, zoneId, slotId, dto.capacity);
  }
}

/** Cotización sin carrito para el backoffice y la demo (el storefront usa /checkout/delivery-options). */
@Controller('logistics/quotes')
export class QuotesController {
  constructor(private readonly quotes: DeliveryQuoteService) {}

  @Post()
  @Auth('logistics.read')
  @HttpCode(200)
  quote(@CurrentUser() user: AuthUser, @Body() dto: StaffQuoteDto) {
    return this.quotes.quote({
      tenantId: user.tenantId,
      destination: dto.destination,
      weightG: dto.weightG,
      volumeCm3: dto.volumeCm3 ?? 0,
      merchandiseTotal: dto.merchandiseTotal ?? '0',
    });
  }
}
