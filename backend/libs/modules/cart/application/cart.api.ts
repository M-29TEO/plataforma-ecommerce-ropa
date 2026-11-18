import { Injectable } from '@nestjs/common';
import { hashGuestToken, isWellFormedGuestToken } from '../domain/cart';
import { CartDraft, CartOutcome, CartService, CartView } from './cart.service';

/**
 * Fachada síncrona para otros módulos: IAM fusiona el carrito del invitado al iniciar sesión y
 * Checkout lee el carrito con precios (y el envío ya cotizado) y lo marca como convertido.
 */
@Injectable()
export class CartApi {
  constructor(private readonly carts: CartService) {}

  /** Al iniciar sesión. El llamador debe borrar la cookie si clearGuestToken es true. */
  mergeGuestCart(tenantId: string, userId: string, guestToken: string): Promise<CartOutcome> {
    return this.carts.merge({ tenantId, userId, guestToken });
  }

  getPricedCart(tenantId: string, cartId: string, shippingTotal?: string): Promise<CartView> {
    return this.carts.priceById(tenantId, cartId, shippingTotal);
  }

  /** Pedidos asistidos: cotiza ítems sueltos como un carrito, sin guardarlo (ver CartService.priceDraft). */
  priceDraft(draft: CartDraft, shippingTotal?: string): Promise<CartView> {
    return this.carts.priceDraft(draft, shippingTotal);
  }

  /** Dentro de la transacción del checkout: id del carrito activo del dueño, con la fila bloqueada. */
  lockCartForCheckout(tenantId: string, userId: string | null, guestToken: string | null): Promise<string> {
    return this.carts.lockForCheckout({ tenantId, userId, guestToken });
  }

  /** Checkout (cotizar el envío): id del carrito activo del dueño, sin bloquearlo. */
  findActiveCartId(tenantId: string, userId: string | null, guestToken: string | null): Promise<string> {
    return this.carts.activeCartId({ tenantId, userId, guestToken });
  }

  /**
   * Identidad estable del dueño para idempotencia: 'user:<id>' o 'guest:<sha256 de la cookie>'.
   * No depende del carrito (que deja de estar activo tras el checkout). null si no hay ninguno.
   */
  ownerRef(userId: string | null, guestToken: string | null): string | null {
    if (userId) return `user:${userId}`;
    return isWellFormedGuestToken(guestToken) ? `guest:${hashGuestToken(guestToken).toString('hex')}` : null;
  }

  markConverted(tenantId: string, cartId: string): Promise<void> {
    return this.carts.markConverted(tenantId, cartId);
  }
}
