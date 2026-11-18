import { Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Audited, Auth, AuthUser, CurrentUser, sendStoredFile } from '../../../shared-kernel';
import { DocumentFile, DocumentQueryService } from '../application/document-query.service';
import { ListDocumentsQuery } from './dto/billing.dto';

/** El RIDE (PDF) se abre en el navegador; el XML firmado se descarga (no se interpreta en el dominio de la tienda). */
function sendFile(res: Response, file: DocumentFile): void {
  sendStoredFile(res, file, { filename: file.filename, download: file.contentType.includes('xml') });
}

/** Backoffice: comprobantes electrónicos, su estado ante el SRI y sus archivos. */
@Controller('billing/documents')
export class BillingDocumentsController {
  constructor(private readonly queries: DocumentQueryService) {}

  /** GET /billing/documents?status=returned,not_authorized (lo que requiere revisión) · ?docType=04 (notas de crédito). */
  @Get()
  @Auth('billing.read')
  list(@CurrentUser() user: AuthUser, @Query() q: ListDocumentsQuery) {
    return this.queries.list(user.tenantId, {
      orderId: q.orderId,
      returnId: q.returnId,
      docType: q.docType,
      statuses: q.status,
      limit: q.limit,
      offset: q.offset,
    });
  }

  @Get(':id')
  @Auth('billing.read')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.queries.get(user.tenantId, id);
  }

  /** Descargas del backoffice: comprobantes con datos del comprador, quedan en la auditoría. */
  @Get(':id/xml')
  @Auth('billing.read')
  @Audited('billing.document.download', { entity: 'electronic_document' })
  async xml(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    sendFile(res, await this.queries.file(user.tenantId, id, 'xml'));
  }

  @Get(':id/ride.pdf')
  @Auth('billing.read')
  @Audited('billing.document.download', { entity: 'electronic_document' })
  async ride(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    sendFile(res, await this.queries.file(user.tenantId, id, 'ride'));
  }
}

function assertCustomer(user: AuthUser): void {
  if (user.type !== 'customer') throw new ForbiddenException('Solo para clientes');
}

/** "Mis pedidos": la factura de un pedido propio (el invitado la recibe por email). */
@Controller('me/orders/:orderId/invoice')
export class MyInvoiceController {
  constructor(private readonly queries: DocumentQueryService) {}

  @Get()
  @Auth()
  get(@CurrentUser() user: AuthUser, @Param('orderId', ParseUUIDPipe) orderId: string) {
    assertCustomer(user);
    return this.queries.forCustomerOrder(user.tenantId, user.id, orderId);
  }

  @Get('ride.pdf')
  @Auth()
  async ride(@CurrentUser() user: AuthUser, @Param('orderId', ParseUUIDPipe) orderId: string, @Res() res: Response) {
    assertCustomer(user);
    sendFile(res, await this.queries.customerFile(user.tenantId, user.id, orderId, 'ride'));
  }

  @Get('xml')
  @Auth()
  async xml(@CurrentUser() user: AuthUser, @Param('orderId', ParseUUIDPipe) orderId: string, @Res() res: Response) {
    assertCustomer(user);
    sendFile(res, await this.queries.customerFile(user.tenantId, user.id, orderId, 'xml'));
  }
}
