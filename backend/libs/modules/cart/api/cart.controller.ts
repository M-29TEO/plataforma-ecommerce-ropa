import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { APP_CONFIG, AppConfig, AuthUser, OptionalAuth, OptionalUser, RateLimit, TenantId } from '../../../shared-kernel';
import { CartOutcome, CartOwner, CartService } from '../application/cart.service';
import { AddItemDto, ApplyCouponDto, ContactDto, CouponCodeParam, SetQuantityDto } from './dto/cart.dto';

export const CART_COOKIE = 'cart_token';

/** Lee una cookie del header Cookie sin depender de cookie-parser. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Carrito del cliente (Bearer token de tipo customer) o del invitado (cookie httpOnly
 * `cart_token` + header X-Tenant-Id). La cookie es httpOnly (JavaScript no la lee: un XSS no
 * roba el carrito), SameSite=Lax (no viaja en POST de otros sitios: sin CSRF) y Secure en
 * producción. Cuando un cliente autenticado llega con la cookie, su carrito de invitado se
 * fusiona en el suyo y la cookie se borra.
 */
@Controller('cart')
@OptionalAuth()
export class CartController {
  constructor(
    private readonly carts: CartService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  get(@OptionalUser() user: AuthUser | undefined, @TenantId() tenantId: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.reply(res, this.carts.get(this.owner(user, tenantId, req)));
  }

  @Post('items')
  @HttpCode(200)
  addItem(
    @OptionalUser() user: AuthUser | undefined,
    @TenantId() tenantId: string,
    @Body() dto: AddItemDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.reply(res, this.carts.addItem(this.owner(user, tenantId, req), dto.variantId, dto.quantity));
  }

  @Patch('items/:variantId')
  setQuantity(
    @OptionalUser() user: AuthUser | undefined,
    @TenantId() tenantId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: SetQuantityDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.reply(res, this.carts.setQuantity(this.owner(user, tenantId, req), variantId, dto.quantity));
  }

  @Delete('items/:variantId')
  removeItem(
    @OptionalUser() user: AuthUser | undefined,
    @TenantId() tenantId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.reply(res, this.carts.removeItem(this.owner(user, tenantId, req), variantId));
  }

  /** Probar códigos uno tras otro es enumerar cupones: perfil 'lookup'. */
  @Post('coupons')
  @HttpCode(200)
  @RateLimit('lookup')
  addCoupon(
    @OptionalUser() user: AuthUser | undefined,
    @TenantId() tenantId: string,
    @Body() dto: ApplyCouponDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.reply(res, this.carts.addCoupon(this.owner(user, tenantId, req), dto.code));
  }

  @Delete('coupons/:code')
  removeCoupon(
    @OptionalUser() user: AuthUser | undefined,
    @TenantId() tenantId: string,
    @Param() params: CouponCodeParam,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.reply(res, this.carts.removeCoupon(this.owner(user, tenantId, req), params.code));
  }

  @Put('contact')
  setContact(
    @OptionalUser() user: AuthUser | undefined,
    @TenantId() tenantId: string,
    @Body() dto: ContactDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.reply(res, this.carts.setContact(this.owner(user, tenantId, req), dto));
  }

  @Post('acknowledge-prices')
  @HttpCode(200)
  acknowledgePrices(
    @OptionalUser() user: AuthUser | undefined,
    @TenantId() tenantId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.reply(res, this.carts.acknowledgePrices(this.owner(user, tenantId, req)));
  }

  /** Explícito para el frontend tras el login (GET /cart también fusiona si llega la cookie). */
  @Post('merge')
  @HttpCode(200)
  merge(@OptionalUser() user: AuthUser | undefined, @TenantId() tenantId: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (!user) throw new UnauthorizedException('Inicia sesión para fusionar el carrito');
    const owner = this.owner(user, tenantId, req);
    return this.reply(res, this.carts.merge({ ...owner, userId: user.id }));
  }

  private owner(user: AuthUser | undefined, tenantId: string, req: Request): CartOwner {
    if (user && user.type !== 'customer') throw new ForbiddenException('El carrito es solo para clientes');
    return { tenantId, userId: user?.id ?? null, guestToken: readCookie(req.headers.cookie, CART_COOKIE) };
  }

  private cookieOptions(): CookieOptions {
    return { httpOnly: true, secure: this.config.secureCookies, sameSite: 'lax', path: '/' };
  }

  private async reply(res: Response, pending: Promise<CartOutcome>) {
    const outcome = await pending;
    if (outcome.setGuestToken) {
      res.cookie(CART_COOKIE, outcome.setGuestToken, {
        ...this.cookieOptions(),
        maxAge: this.config.guestCartTtlDays * 24 * 60 * 60 * 1000,
      });
    } else if (outcome.clearGuestToken) {
      res.clearCookie(CART_COOKIE, this.cookieOptions());
    }
    return outcome.cart;
  }
}
