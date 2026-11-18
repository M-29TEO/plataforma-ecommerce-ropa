import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Audited, Auth, AuthUser, CurrentUser } from '../../../shared-kernel';
import { PromotionService } from '../application/promotion.service';
import { CreateCouponDto, CreatePromotionDto, ListPromotionsQuery, UpdatePromotionDto } from './dto/promotion.dto';

/** Backoffice: promociones y sus cupones. */
@Controller('promotions')
export class PromotionsController {
  constructor(private readonly promotions: PromotionService) {}

  @Post()
  @Auth('promotions.write')
  @Audited('promotions.promotion.create', { entity: 'promotion' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreatePromotionDto) {
    return this.promotions.create(user.tenantId, dto);
  }

  @Get()
  @Auth('promotions.read')
  list(@CurrentUser() user: AuthUser, @Query() q: ListPromotionsQuery) {
    return this.promotions.list(user.tenantId, q);
  }

  /** Incluye los cupones con sus contadores de uso. */
  @Get(':id')
  @Auth('promotions.read')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.promotions.get(user.tenantId, id);
  }

  /** active=false para desactivar (no se borran: tienen canjes históricos). */
  @Patch(':id')
  @Auth('promotions.write')
  @Audited('promotions.promotion.update', { entity: 'promotion' })
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePromotionDto) {
    return this.promotions.update(user.tenantId, id, dto);
  }

  @Post(':id/coupons')
  @Auth('promotions.write')
  @Audited('promotions.coupon.create', { entity: 'promotion' })
  createCoupon(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateCouponDto) {
    return this.promotions.createCoupon(user.tenantId, id, dto);
  }
}
