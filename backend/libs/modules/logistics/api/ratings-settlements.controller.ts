import { Body, Controller, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Audited, Auth, AuthUser, CurrentUser } from '../../../shared-kernel';
import { RatingService } from '../application/rating.service';
import { SettlementService } from '../application/settlement.service';
import {
  ApproveSettlementDto,
  DisputeSettlementDto,
  GenerateSettlementsDto,
  ListRatingsQuery,
  ListSettlementsQuery,
  RateDeliveryDto,
} from './dto/ratings-settlements.dto';

function assertType(user: AuthUser, type: AuthUser['type']): void {
  if (user.type !== type) throw new ForbiddenException(type === 'rider' ? 'Solo para motorizados' : 'Solo para clientes');
}

/** El cliente califica al motorizado que le entregó. */
@Controller('me/shipments')
export class MyShipmentsController {
  constructor(private readonly ratings: RatingService) {}

  @Post(':id/rating')
  @Auth()
  rate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RateDeliveryDto) {
    assertType(user, 'customer');
    return this.ratings.rateRider(user.tenantId, user.id, id, dto);
  }
}

/** App del motorizado: califica al cliente y revisa (o disputa) sus liquidaciones. Solo ve lo propio. */
@Controller('rider')
export class RiderAppController {
  constructor(
    private readonly ratings: RatingService,
    private readonly settlements: SettlementService,
  ) {}

  @Post('shipments/:id/rating')
  @Auth()
  rateCustomer(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RateDeliveryDto) {
    assertType(user, 'rider');
    return this.ratings.rateCustomer(user.tenantId, user.id, id, dto);
  }

  @Get('settlements')
  @Auth()
  async listSettlements(@CurrentUser() user: AuthUser, @Query() q: ListSettlementsQuery) {
    assertType(user, 'rider');
    const riderId = await this.settlements.riderIdForUser(user.tenantId, user.id);
    return this.settlements.list(user.tenantId, { ...q, riderId });
  }

  @Get('settlements/:id')
  @Auth()
  async getSettlement(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    assertType(user, 'rider');
    return this.settlements.get(user.tenantId, id, await this.settlements.riderIdForUser(user.tenantId, user.id));
  }

  @Post('settlements/:id/dispute')
  @HttpCode(200)
  @Auth()
  @Audited('logistics.settlement.dispute', { entity: 'settlement' })
  async dispute(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DisputeSettlementDto) {
    assertType(user, 'rider');
    const riderId = await this.settlements.riderIdForUser(user.tenantId, user.id);
    return this.settlements.dispute(user.tenantId, id, dto.reason, { type: 'rider', id: user.id, riderId });
  }
}

@Controller('logistics/riders')
export class RidersController {
  constructor(private readonly ratings: RatingService) {}

  @Get(':id/ratings')
  @Auth('logistics.read')
  ratingsOf(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: ListRatingsQuery) {
    return this.ratings.listForRider(user.tenantId, id, q.limit);
  }
}

/** Backoffice: liquidaciones de motorizados. Generar y disputar ≠ aprobar y pagar (segregación de funciones). */
@Controller('logistics/settlements')
export class SettlementsController {
  constructor(private readonly settlements: SettlementService) {}

  @Get()
  @Auth('logistics.read')
  list(@CurrentUser() user: AuthUser, @Query() q: ListSettlementsQuery) {
    return this.settlements.list(user.tenantId, q);
  }

  /** Mismo cálculo que el job semanal, para el tenant del usuario. Antes de ':id'. */
  @Post('generate')
  @HttpCode(200)
  @Auth('logistics.settlement.manage')
  @Audited('logistics.settlement.generate', { entity: 'settlement' })
  generate(@CurrentUser() user: AuthUser, @Body() dto: GenerateSettlementsDto) {
    return this.settlements.generate({ tenantId: user.tenantId, periodStart: dto.periodStart, rebuildDisputed: dto.rebuildDisputed });
  }

  @Get(':id')
  @Auth('logistics.read')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.settlements.get(user.tenantId, id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Auth('logistics.settlement.approve')
  @Audited('logistics.settlement.approve', { entity: 'settlement' })
  approve(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ApproveSettlementDto) {
    return this.settlements.approve(user.tenantId, id, user.id, dto.codRemitted);
  }

  @Post(':id/dispute')
  @HttpCode(200)
  @Auth('logistics.settlement.manage')
  @Audited('logistics.settlement.dispute', { entity: 'settlement' })
  dispute(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DisputeSettlementDto) {
    return this.settlements.dispute(user.tenantId, id, dto.reason, { type: 'staff', id: user.id });
  }

  @Post(':id/mark-paid')
  @HttpCode(200)
  @Auth('logistics.settlement.approve')
  @Audited('logistics.settlement.mark_paid', { entity: 'settlement' })
  markPaid(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.settlements.markPaid(user.tenantId, id, user.id);
  }
}
