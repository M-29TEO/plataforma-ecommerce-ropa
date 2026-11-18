import { BadRequestException, Body, Controller, ForbiddenException, Headers, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthUser, InvalidIdempotencyKeyError, OptionalAuth, OptionalUser, RateLimit, TenantId } from '../../../shared-kernel';
import { CART_COOKIE, readCookie } from '../../cart';
import { CrmApi } from '../../crm';
import { CheckoutService } from '../application/checkout.service';
import { AddressDto, CheckoutDto, DeliveryOptionsDto } from './dto/checkout.dto';

/**
 * POST /v1/checkout/delivery-options — cotiza el envío del carrito a una dirección (zona propia
 * con motorizado y franjas, o couriers). Devuelve opciones con un `quoteId` firmado.
 *
 * POST /v1/checkout — cliente (Bearer customer) o invitado (cookie del carrito + X-Tenant-Id).
 *
 * Requiere el header Idempotency-Key (un UUID generado por el storefront al abrir la página de
 * pago). Repetir la petición con la misma clave devuelve la misma respuesta con
 * `Idempotent-Replayed: true`, sin crear otro pedido ni otro pago.
 */
@Controller('checkout')
@OptionalAuth()
export class CheckoutController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly crm: CrmApi,
  ) {}

  /**
   * Dirección de entrega: la guardada (addressId, solo con sesión de cliente) o la que llega en el
   * cuerpo. Una guardada sin ubicación responde 400 ADDRESS_NEEDS_PIN.
   */
  private async address(user: AuthUser | undefined, tenantId: string, addressId: string | undefined, inline: AddressDto | undefined): Promise<AddressDto | undefined> {
    if (!addressId) return inline;
    if (!user) throw new BadRequestException('addressId requiere iniciar sesión');
    const a = await this.crm.getCheckoutAddress(tenantId, user.id, addressId);
    return {
      mainStreet: a.mainStreet,
      secondaryStreet: a.secondaryStreet ?? undefined,
      number: a.number ?? undefined,
      reference: a.reference ?? undefined,
      city: a.city,
      province: a.province,
      neighborhood: a.neighborhood ?? undefined,
      lat: a.lat,
      lng: a.lng,
    };
  }

  /** Cada cotización llama a los couriers: perfil 'checkout'. */
  @Post('delivery-options')
  @HttpCode(200)
  @RateLimit('checkout')
  async deliveryOptions(
    @OptionalUser() user: AuthUser | undefined,
    @TenantId() tenantId: string,
    @Body() dto: DeliveryOptionsDto,
    @Req() req: Request,
  ) {
    if (user && user.type !== 'customer') throw new ForbiddenException('El checkout es para clientes');
    const address = (await this.address(user, tenantId, dto.addressId, dto.shippingAddress))!;
    return this.checkout.deliveryOptions({
      tenantId,
      userId: user?.id ?? null,
      guestToken: user ? null : readCookie(req.headers.cookie, CART_COOKIE),
      location: { lat: address.lat!, lng: address.lng! },
      city: address.city,
      province: address.province ?? null,
    });
  }

  /** Reserva stock y crea el pago en la pasarela: perfil 'checkout'. */
  @Post()
  @RateLimit('checkout')
  async create(
    @OptionalUser() user: AuthUser | undefined,
    @TenantId() tenantId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CheckoutDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (user && user.type !== 'customer') throw new ForbiddenException('El checkout es para clientes');
    if (!idempotencyKey) throw new InvalidIdempotencyKeyError();
    const address = dto.fulfillmentType === 'pickup' ? dto.shippingAddress : await this.address(user, tenantId, dto.addressId, dto.shippingAddress);
    const result = await this.checkout.checkout({
      tenantId,
      userId: user?.id ?? null,
      guestToken: user ? null : readCookie(req.headers.cookie, CART_COOKIE),
      idempotencyKey,
      customer: dto.customer,
      billing: dto.billing ? { ...dto.billing } : null,
      fulfillmentType: dto.fulfillmentType,
      shippingAddress: address ? { ...address } : null,
      shippingLocation: address?.lat !== undefined && address.lng !== undefined ? { lat: address.lat, lng: address.lng } : null,
      shippingCity: address?.city ?? null,
      shippingProvince: address?.province ?? null,
      deliveryQuoteId: dto.deliveryQuoteId ?? null,
      deliverySlotId: dto.deliverySlotId ?? null,
      pickupWarehouseId: dto.pickupWarehouseId ?? null,
      paymentMethod: dto.paymentMethod,
      giftCardCode: dto.giftCardCode ?? null,
      expectedTotal: dto.expectedTotal ?? null,
      notes: dto.notes ?? null,
      channel: dto.channel,
    });
    res.status(result.status);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }
}
