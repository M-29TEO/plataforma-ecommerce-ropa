import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Audited, Auth, AuthUser, CurrentUser } from '../../../shared-kernel';
import { RefundService } from '../application/refund.service';
import { CompleteTransferRefundDto, ListRefundsQuery } from './dto/refund.dto';

/**
 * Backoffice: reembolsos. La aprobación (POST /refunds/:id/approve) la expone el orquestador de
 * posventa, porque la aprobación final ejecuta también las partes en gift card (Promociones).
 */
@Controller('refunds')
export class RefundsController {
  constructor(private readonly refunds: RefundService) {}

  /** Cola de aprobación: GET /refunds?status=pending · por transferir: ?status=processing */
  @Get()
  @Auth('payments.read')
  list(@CurrentUser() user: AuthUser, @Query() q: ListRefundsQuery) {
    return this.refunds.list(user.tenantId, { statuses: q.status, orderId: q.orderId, returnId: q.returnId, limit: q.limit, offset: q.offset });
  }

  @Get(':id')
  @Auth('payments.read')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.refunds.get(user.tenantId, id);
  }

  /** Finanzas hizo la transferencia al cliente: la registra con la referencia bancaria. */
  @Post(':id/transfer/complete')
  @HttpCode(200)
  @Auth('payments.refund.complete')
  @Audited('payments.refund.complete_transfer', { entity: 'refund' })
  completeTransfer(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CompleteTransferRefundDto) {
    return this.refunds.completeTransfer(user.tenantId, id, dto);
  }
}
