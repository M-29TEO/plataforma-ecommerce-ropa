import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { Audited, Auth, AuthUser, CurrentUser, InvalidIdempotencyKeyError } from '../../../shared-kernel';
import { VOUCHER_MAX_BYTES, VoucherFile } from '../../payments';
import { AssistedCustomerRef, AssistedFulfillment, AssistedOrderService } from '../application/assisted-order.service';
import {
  AssistedCustomerDto,
  AssistedFulfillmentDto,
  AssistedQuoteDto,
  CreateAssistedOrderDto,
  ListAssistedOrdersQuery,
  SearchCustomersQuery,
  StaffVoucherDto,
} from './dto/assisted-order.dto';

const PERMISSION = 'orders.assisted.create';

/**
 * Pedidos asistidos (backoffice): el vendedor busca o registra al cliente, cotiza y crea el
 * pedido a su nombre (teléfono, WhatsApp, tienda). Rol vendedor o administrador.
 *
 *  GET  /v1/assisted-orders/customers?q=   clientes del tenant (máx. 20) con sus direcciones
 *  POST /v1/assisted-orders/quote          totales y opciones de envío con token firmado
 *  POST /v1/assisted-orders                crea pedido + reserva + pago (header Idempotency-Key)
 *  GET  /v1/assisted-orders?mine=&limit=&offset=   pedidos del canal backoffice
 *  POST /v1/assisted-orders/:orderId/transfer-voucher   el vendedor sube el comprobante (multipart "file")
 */
@Controller('assisted-orders')
export class AssistedOrdersController {
  constructor(private readonly assisted: AssistedOrderService) {}

  @Get('customers')
  @Auth(PERMISSION)
  searchCustomers(@CurrentUser() user: AuthUser, @Query() q: SearchCustomersQuery) {
    return this.assisted.searchCustomers(user.tenantId, q.q);
  }

  @Post('quote')
  @HttpCode(200)
  @Auth(PERMISSION)
  quote(@CurrentUser() user: AuthUser, @Body() dto: AssistedQuoteDto) {
    return this.assisted.quote({
      tenantId: user.tenantId,
      customer: dto.customer ? customerRef(dto.customer) : undefined,
      items: dto.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
      couponCode: dto.couponCode,
      fulfillment: fulfillment(dto.fulfillment),
    });
  }

  @Post()
  @Auth(PERMISSION)
  async create(
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateAssistedOrderDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey) throw new InvalidIdempotencyKeyError();
    const result = await this.assisted.create({
      tenantId: user.tenantId,
      sellerId: user.id,
      idempotencyKey,
      customer: customerRef(dto.customer),
      items: dto.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
      couponCode: dto.couponCode,
      fulfillment: { ...fulfillment(dto.fulfillment), quoteToken: dto.fulfillment.quoteToken, slotId: dto.fulfillment.slotId },
      paymentMethod: dto.paymentMethod,
      billing: dto.billing ? { ...dto.billing } : null,
      notes: dto.notes ?? null,
      expectedTotal: dto.expectedTotal ?? null,
    });
    res.status(result.status);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }

  @Get()
  @Auth(PERMISSION)
  list(@CurrentUser() user: AuthUser, @Query() q: ListAssistedOrdersQuery) {
    return this.assisted.list(user.tenantId, q.mine === false ? null : user.id, q.limit ?? 20, q.offset ?? 0);
  }

  /**
   * Comprobante de transferencia que el cliente mandó por WhatsApp. Multipart: "file" (JPG, PNG o
   * PDF, máx. 5 MB, tipo verificado por magic bytes), "bankName" y "reference" opcionales. Responde
   * el estado del pago (pending: por verificar con payments.transfer.verify). Auditado con el actor staff.
   */
  @Post(':orderId/transfer-voucher')
  @HttpCode(200)
  @Auth(PERMISSION)
  @Audited('orders.assisted.transfer_voucher', { entity: 'order', idParam: 'orderId', body: false })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: VOUCHER_MAX_BYTES + 1, files: 1 } }))
  submitTransferVoucher(
    @CurrentUser() user: AuthUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: StaffVoucherDto,
    @UploadedFile() file: VoucherFile | undefined,
  ) {
    return this.assisted.submitTransferVoucher(user.tenantId, orderId, user.id, {
      bankName: dto.bankName?.trim() || STAFF_VOUCHER_BANK,
      reference: dto.reference ?? null,
      file,
    });
  }
}

/** bank_transfers.bank_name es obligatorio: si el vendedor no lo sabe, queda así para el verificador. */
const STAFF_VOUCHER_BANK = 'No indicado (subido por el vendedor)';

function customerRef(dto: AssistedCustomerDto): AssistedCustomerRef {
  if (dto.userId) return { userId: dto.userId };
  const g = dto.guest!;
  return { guest: { email: g.email, firstName: g.firstName, lastName: g.lastName, phone: g.phone, idType: g.idType, idNumber: g.idNumber } };
}

/** Copia plana del DTO (sin prototipos de class-transformer) para el servicio y la idempotencia. */
function fulfillment(dto: AssistedFulfillmentDto): AssistedFulfillment {
  return {
    type: dto.type,
    address: dto.address ? { ...dto.address } : undefined,
    location: dto.location ? { lat: dto.location.lat, lng: dto.location.lng } : undefined,
    addressId: dto.addressId,
    pickupWarehouseId: dto.pickupWarehouseId,
  };
}
