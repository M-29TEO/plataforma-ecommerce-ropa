import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../../shared-kernel';
import { DispatchService } from '../application/dispatch.service';
import { RiderAppService } from '../application/rider-app.service';
import { EarningsQuery, OfferIdParam, RejectOfferDto, StartShiftDto } from './dto/rider-app.dto';
import { assertType } from './tracking.controller';

/**
 * App del motorizado: perfil (con su tópico de ntfy), turnos, ofertas del despacho automático y
 * ganancias. Sus envíos, estados, entrega y GPS están en RiderTrackingController.
 */
@Controller('rider')
export class RiderWorkController {
  constructor(
    private readonly app: RiderAppService,
    private readonly dispatch: DispatchService,
  ) {}

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    assertType(user, 'rider');
    return this.app.me(user.tenantId, user.id);
  }

  @Post('shift/start')
  @HttpCode(201)
  startShift(@CurrentUser() user: AuthUser, @Body() dto: StartShiftDto) {
    assertType(user, 'rider');
    const location = dto.lat !== undefined && dto.lng !== undefined ? { lat: dto.lat, lng: dto.lng } : null;
    return this.app.startShift(user.tenantId, user.id, location);
  }

  @Post('shift/end')
  @HttpCode(200)
  endShift(@CurrentUser() user: AuthUser) {
    assertType(user, 'rider');
    return this.app.endShift(user.tenantId, user.id);
  }

  @Get('offers')
  offers(@CurrentUser() user: AuthUser) {
    assertType(user, 'rider');
    return this.dispatch.listForRider(user.tenantId, user.id);
  }

  @Post('offers/:id/accept')
  @HttpCode(200)
  accept(@CurrentUser() user: AuthUser, @Param() p: OfferIdParam) {
    assertType(user, 'rider');
    return this.dispatch.accept(user.tenantId, user.id, p.id);
  }

  @Post('offers/:id/reject')
  @HttpCode(204)
  async reject(@CurrentUser() user: AuthUser, @Param() p: OfferIdParam, @Body() dto: RejectOfferDto) {
    assertType(user, 'rider');
    await this.dispatch.reject(user.tenantId, user.id, p.id, dto.reason?.trim() || null);
  }

  @Get('earnings')
  earnings(@CurrentUser() user: AuthUser, @Query() q: EarningsQuery) {
    assertType(user, 'rider');
    return this.app.earnings(user.tenantId, user.id, q.from, q.to);
  }
}
