import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { Audited, Auth, AuthUser, CurrentUser, OptionalAuth, RateLimit, sendStoredFile, TenantId } from '../../../shared-kernel';
import { PaymentService } from '../application/payment.service';
import { TransferService, VOUCHER_MAX_BYTES, VoucherFile } from '../application/transfer.service';
import { ListPaymentsQuery, RejectTransferDto, SubmitVoucherDto } from './dto/payment.dto';

export const PAYMENT_SECRET_HEADER = 'x-payment-secret';

/** Backoffice: consulta de pagos y verificación manual de transferencias. */
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentService,
    private readonly transfers: TransferService,
  ) {}

  /** Cola de verificación: GET /payments?method=transfer&status=pending */
  @Get()
  @Auth('payments.read')
  list(@CurrentUser() user: AuthUser, @Query() q: ListPaymentsQuery) {
    return this.payments.list(user.tenantId, { statuses: q.status, method: q.method, orderId: q.orderId, limit: q.limit, offset: q.offset });
  }

  @Get(':id')
  @Auth('payments.read')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.get(user.tenantId, id);
  }

  @Get(':id/transfer/voucher')
  @Auth('payments.read')
  @Audited('payments.voucher.view', { entity: 'payment' })
  async voucher(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const file = await this.transfers.getVoucher(user.tenantId, id);
    sendStoredFile(res, file);
  }

  @Post(':id/transfer/approve')
  @HttpCode(200)
  @Auth('payments.transfer.verify')
  @Audited('payments.transfer.approve', { entity: 'payment' })
  approve(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.transfers.approve(user.tenantId, id, user.id);
  }

  @Post(':id/transfer/reject')
  @HttpCode(200)
  @Auth('payments.transfer.verify')
  @Audited('payments.transfer.reject', { entity: 'payment' })
  reject(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectTransferDto) {
    return this.transfers.reject(user.tenantId, id, user.id, dto.reason);
  }
}

/**
 * Cliente o invitado con el client secret que devolvió el checkout (header X-Payment-Secret):
 * estado del pago (página de resultado) y subida del comprobante de transferencia. Perfil
 * 'checkout' en ambas: se prueban secretos contra un id y la subida es un upload de hasta 5 MB.
 */
@Controller('payments')
@OptionalAuth()
export class CustomerPaymentsController {
  constructor(
    private readonly payments: PaymentService,
    private readonly transfers: TransferService,
  ) {}

  // Sin perfil estricto: la página de resultado consulta el estado en bucle y exige el client secret (no adivinable).
  @Get(':id/public')
  status(@TenantId() tenantId: string, @Param('id', ParseUUIDPipe) id: string, @Headers(PAYMENT_SECRET_HEADER) secret?: string) {
    return this.payments.getPublic(tenantId, id, secret);
  }

  @Post(':id/transfer/voucher')
  @HttpCode(200)
  @RateLimit('checkout')
  @UseInterceptors(FileInterceptor('voucher', { limits: { fileSize: VOUCHER_MAX_BYTES + 1, files: 1 } }))
  submitVoucher(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers(PAYMENT_SECRET_HEADER) secret: string | undefined,
    @Body() dto: SubmitVoucherDto,
    @UploadedFile() file: VoucherFile | undefined,
  ) {
    return this.transfers.submitVoucher(tenantId, id, secret, { bankName: dto.bankName, reference: dto.reference, file });
  }
}
