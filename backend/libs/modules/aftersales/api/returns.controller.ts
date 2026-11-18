import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { Audited, Auth, AuthUser, CurrentUser, sendStoredFile } from '../../../shared-kernel';
import { MAX_PHOTOS_PER_ITEM } from '../../orders';
import { AftersalesService, PHOTO_MAX_BYTES, PhotoFile } from '../application/aftersales.service';
import { CreateReturnDto, InspectReturnDto, ListReturnsQuery, ReceiveReturnDto, RegisterReturnDto, RejectReturnDto } from './dto/returns.dto';

function assertCustomer(user: AuthUser): void {
  if (user.type !== 'customer') throw new ForbiddenException('Solo para clientes');
}

function staff(user: AuthUser) {
  if (user.type === 'customer') throw new ForbiddenException('Los clientes usan /me/returns');
  return { tenantId: user.tenantId, userId: user.id };
}

/**
 * Cliente: solicitar una devolución o un cambio de talla sobre un pedido entregado (motivos y
 * fotos) y seguir sus devoluciones. Una devolución ajena responde 404.
 */
@Controller()
export class CustomerReturnsController {
  constructor(private readonly aftersales: AftersalesService) {}

  /** multipart con el campo "photo" (jpg, png o webp, hasta 5 MB). Devuelve la clave para la solicitud. */
  @Post('me/returns/photos')
  @HttpCode(201)
  @Auth()
  @UseInterceptors(FileInterceptor('photo', { limits: { fileSize: PHOTO_MAX_BYTES + 1, files: 1 } }))
  uploadPhoto(@CurrentUser() user: AuthUser, @UploadedFile() file: PhotoFile | undefined) {
    assertCustomer(user);
    return this.aftersales.uploadPhoto(user.tenantId, user.id, file);
  }

  @Post('me/orders/:orderId/returns')
  @HttpCode(201)
  @Auth()
  request(@CurrentUser() user: AuthUser, @Param('orderId', ParseUUIDPipe) orderId: string, @Body() dto: CreateReturnDto) {
    assertCustomer(user);
    return this.aftersales.requestReturn({ tenantId: user.tenantId, userId: user.id, orderId, ...dto });
  }

  @Get('me/returns')
  @Auth()
  list(@CurrentUser() user: AuthUser, @Query() q: ListReturnsQuery) {
    assertCustomer(user);
    return this.aftersales.listForCustomer(user.tenantId, user.id, { statuses: q.status, orderId: q.orderId, limit: q.limit, offset: q.offset });
  }

  @Get('me/returns/:id')
  @Auth()
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    assertCustomer(user);
    return this.aftersales.getForCustomer(user.tenantId, user.id, id);
  }
}

/** Backoffice y bodega: aprobación, recepción, inspección y seguimiento de devoluciones. */
@Controller('returns')
export class ReturnsController {
  constructor(private readonly aftersales: AftersalesService) {}

  /** Cola de trabajo: GET /returns?status=requested (por aprobar) · ?status=pickup_scheduled,received (bodega). */
  @Get()
  @Auth('returns.read')
  list(@CurrentUser() user: AuthUser, @Query() q: ListReturnsQuery) {
    return this.aftersales.list(user.tenantId, { statuses: q.status, orderId: q.orderId, limit: q.limit, offset: q.offset });
  }

  /** Soporte registra la devolución por el cliente (p. ej. un invitado que llama). Queda 'requested', como la del cliente. */
  @Post()
  @HttpCode(201)
  @Auth('returns.approve')
  @Audited('aftersales.return.register', { entity: 'return' })
  register(@CurrentUser() user: AuthUser, @Body() dto: RegisterReturnDto) {
    const { orderId, ...rest } = dto;
    return this.aftersales.registerReturn(staff(user), { orderId, ...rest });
  }

  /** Devolución con su retiro, su envío de cambio y su reembolso. */
  @Get(':id')
  @Auth('returns.read')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.aftersales.overview(user.tenantId, id);
  }

  @Get(':id/items/:itemId/photos/:index')
  @Auth('returns.read')
  @Audited('aftersales.return_photo.view', { entity: 'return' })
  async photo(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Param('index', ParseIntPipe) index: number,
    @Res() res: Response,
  ) {
    // Índice fuera de rango: 400 aquí, sin leer la devolución ni el almacén.
    if (index < 0 || index >= MAX_PHOTOS_PER_ITEM) throw new BadRequestException(`index: de 0 a ${MAX_PHOTOS_PER_ITEM - 1}`);
    const file = await this.aftersales.photo(user.tenantId, id, itemId, index);
    sendStoredFile(res, file);
  }

  /** Aprueba y programa el retiro con Logística (envío con direction 'return'). */
  @Post(':id/approve')
  @HttpCode(200)
  @Auth('returns.approve')
  @Audited('aftersales.return.approve', { entity: 'return' })
  approve(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.aftersales.approve(staff(user), id);
  }

  /** Antes de aprobar, o tras recibir si la inspección no la acepta. */
  @Post(':id/reject')
  @HttpCode(200)
  @Auth('returns.approve')
  @Audited('aftersales.return.reject', { entity: 'return' })
  reject(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectReturnDto) {
    return this.aftersales.reject(staff(user), id, dto.reason);
  }

  @Post(':id/receive')
  @HttpCode(200)
  @Auth('returns.inspect')
  @Audited('aftersales.return.receive', { entity: 'return' })
  receive(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReceiveReturnDto) {
    return this.aftersales.receive(staff(user), id, dto.warehouseId ?? null);
  }

  /** Condición y reingreso al stock de cada línea; solicita el reembolso o despacha la talla nueva. */
  @Post(':id/inspect')
  @HttpCode(200)
  @Auth('returns.inspect')
  @Audited('aftersales.return.inspect', { entity: 'return' })
  inspect(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: InspectReturnDto) {
    return this.aftersales.inspect(staff(user), id, dto.items);
  }

  /** Cambio que quedó sin stock en la inspección: reintenta la salida de la talla nueva y su envío. */
  @Post(':id/exchange-shipment')
  @HttpCode(200)
  @Auth('returns.inspect')
  @Audited('aftersales.return.retry_exchange', { entity: 'return' })
  retryExchange(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.aftersales.retryExchangeShipment(staff(user), id);
  }
}

/**
 * Aprobación de reembolsos. Vive en el orquestador porque la aprobación final ejecuta en la misma
 * transacción las partes en gift card (Promociones); consulta y transferencias: /refunds de Pagos.
 */
@Controller('refunds')
export class RefundApprovalsController {
  constructor(private readonly aftersales: AftersalesService) {}

  /** Por encima de REFUND_DUAL_APPROVAL_ABOVE hacen falta dos aprobaciones de personas distintas. */
  @Post(':id/approve')
  @HttpCode(200)
  @Auth('payments.refund.approve')
  @Audited('aftersales.refund.approve', { entity: 'refund' })
  approve(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.aftersales.approveRefund(staff(user), id);
  }
}
