import { Body, Controller, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe, Post, Res, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { Audited, AuthUser, CurrentUser, Public, RequirePermission, sendStoredFile, TenantId } from '../../../shared-kernel';
import { DispatchService } from '../application/dispatch.service';
import { TrackingService } from '../application/tracking.service';
import { PROOF_PHOTO_MAX_BYTES, ProofFile } from '../domain/delivery-proof';
import { AssignRiderDto, DeliverDto, RiderPositionDto, RiderStatusDto, TrackingTokenParam } from './dto/tracking.dto';

export function assertType(user: AuthUser, type: AuthUser['type']): void {
  if (user.type !== type) throw new ForbiddenException(type === 'rider' ? 'Solo para motorizados' : 'Solo para clientes');
}

/**
 * Seguimiento público (/seguimiento/<token> del storefront). El token es el secreto: no hace falta
 * sesión, así un invitado sigue su pedido desde el email. No devuelve datos de contacto; mientras
 * el paquete va en camino incluye el código de entrega (deliveryCode) que el cliente dicta.
 */
@Controller('tracking')
@Public()
export class PublicTrackingController {
  constructor(private readonly tracking: TrackingService) {}

  @Get(':token')
  get(@TenantId() tenantId: string, @Param() p: TrackingTokenParam) {
    return this.tracking.publicView(tenantId, p.token);
  }
}

/** Envíos de un pedido propio (enlaza "mis pedidos" con el seguimiento y muestra el código de entrega). */
@Controller('me/orders/:orderId/shipments')
export class MyOrderShipmentsController {
  constructor(private readonly tracking: TrackingService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Param('orderId', ParseUUIDPipe) id: string) {
    assertType(user, 'customer');
    return this.tracking.forCustomerOrder(user.tenantId, user.id, id);
  }
}

/** Backoffice: asignación manual, despacho automático a pedido y pruebas de entrega. */
@Controller('logistics/shipments')
export class DispatchController {
  constructor(
    private readonly tracking: TrackingService,
    private readonly dispatch: DispatchService,
  ) {}

  @Post(':id/assign')
  @HttpCode(200)
  @RequirePermission('logistics.dispatch')
  @Audited('logistics.shipment.assign', { entity: 'shipment' })
  assign(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignRiderDto) {
    return this.tracking.assign(user.tenantId, id, dto.riderId, { type: 'staff', id: user.id });
  }

  /** Ofrece el envío al mejor motorizado disponible ya (sin esperar al job). 409 NO_RIDER_AVAILABLE. */
  @Post(':id/dispatch')
  @HttpCode(200)
  @RequirePermission('logistics.dispatch')
  @Audited('logistics.shipment.dispatch', { entity: 'shipment' })
  dispatchNow(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.dispatch.dispatchNow(user.tenantId, id);
  }

  @Get(':id/proofs')
  @RequirePermission('logistics.read')
  proofs(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tracking.listProofs(user.tenantId, id);
  }
}

/** Backoffice: foto o firma de una prueba de entrega (tipo verificado al subirla). */
@Controller('logistics/proofs')
export class DeliveryProofsController {
  constructor(private readonly tracking: TrackingService) {}

  @Get(':id/file')
  @RequirePermission('logistics.read')
  @Audited('logistics.proof.view', { entity: 'delivery_proof' })
  async file(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    sendStoredFile(res, await this.tracking.proofFile(user.tenantId, id));
  }
}

type DeliverFiles = { photo?: ProofFile[]; signature?: ProofFile[] };

/** App del motorizado: sus envíos, estados, entrega con prueba y posición GPS. */
@Controller('rider')
export class RiderTrackingController {
  constructor(private readonly tracking: TrackingService) {}

  @Get('shipments')
  active(@CurrentUser() user: AuthUser) {
    assertType(user, 'rider');
    return this.tracking.activeForRider(user.tenantId, user.id);
  }

  /** Un envío propio en cualquier estado (también ya entregado). Uno ajeno: 404. */
  @Get('shipments/:id')
  one(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    assertType(user, 'rider');
    return this.tracking.getForRider(user.tenantId, user.id, id);
  }

  @Post('shipments/:id/status')
  @HttpCode(200)
  status(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RiderStatusDto) {
    assertType(user, 'rider');
    const location = dto.lat !== undefined && dto.lng !== undefined ? { lat: dto.lat, lng: dto.lng } : null;
    return this.tracking.riderStatus(user.tenantId, user.id, id, dto.status, location, dto.reason ?? null);
  }

  /**
   * multipart/form-data: lat, lng, receiverName, otp, codCollected, codMethod y los archivos
   * "photo" (JPG/PNG ≤ 5 MB) y "signature" (PNG ≤ 1 MB), ambos obligatorios.
   */
  @Post('shipments/:id/deliver')
  @HttpCode(200)
  @Audited('logistics.shipment.deliver', { entity: 'shipment' })
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'photo', maxCount: 1 },
        { name: 'signature', maxCount: 1 },
      ],
      { limits: { fileSize: PROOF_PHOTO_MAX_BYTES + 1, files: 2, fields: 10 } },
    ),
  )
  deliver(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DeliverDto, @UploadedFiles() files: DeliverFiles | undefined) {
    assertType(user, 'rider');
    return this.tracking.deliver(user.tenantId, user.id, id, {
      location: { lat: dto.lat, lng: dto.lng },
      receiverName: dto.receiverName,
      otp: dto.otp,
      codCollected: dto.codCollected,
      codMethod: dto.codMethod,
      photo: files?.photo?.[0],
      signature: files?.signature?.[0],
    });
  }

  @Post('location')
  @HttpCode(202)
  location(@CurrentUser() user: AuthUser, @Body() dto: RiderPositionDto) {
    assertType(user, 'rider');
    return this.tracking.recordPosition(user.tenantId, user.id, dto);
  }
}
