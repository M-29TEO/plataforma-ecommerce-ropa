import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig, Database, Queryable, toCents } from '../../../shared-kernel';
import { CatalogApi } from '../../catalog';
import { InventoryApi } from '../../inventory';
import { CouponRejection, PricingResult, PromotionsApi, PromotionType } from '../../promotions';
import { Cart, generateGuestToken, hashGuestToken, isWellFormedGuestToken } from '../domain/cart';
import { analyzeLines, CartLineView, CartTotals, isBlocking, priceLines, TaxBreakdown } from '../domain/cart-pricing';
import { CartInsufficientStockError, CartNotFoundError, CouponRejectedError, VariantNotFoundError, VariantUnavailableError } from '../domain/errors';
import { CartRepository } from './ports';

/** Quién pide el carrito: un cliente autenticado, un invitado con cookie, o ambos (recién logueado). */
export interface CartOwner {
  tenantId: string;
  userId: string | null;
  /** Token en claro de la cookie httpOnly (null si no vino o está mal formado). */
  guestToken: string | null;
}

export interface CouponStatus {
  code: string;
  applied: boolean;
  discount: string | null;
  reason: string | null;
  message: string | null;
}

export interface CartView {
  /** null si todavía no existe carrito (vista vacía). */
  id: string | null;
  guest: boolean;
  currency: string;
  contactEmail: string | null;
  items: CartLineView[];
  coupons: CouponStatus[];
  promotions: {
    promotionId: string;
    name: string;
    type: PromotionType;
    couponId: string | null;
    couponCode: string | null;
    discount: string;
    freeShipping: boolean;
    /** Cuánto descuenta del envío cotizado (0 si no se pasó envío). */
    shippingDiscount: string;
  }[];
  /** "Te faltan $X para ..." de promociones automáticas con monto mínimo. */
  hints: PricingResult['hints'];
  totals: CartTotals;
  freeShipping: boolean;
  /** Descuento sobre el envío cotizado (shippingTotal de getPricedCart). */
  shippingDiscount: string;
  taxes: TaxBreakdown[];
  hasPriceChanges: boolean;
  /** Hay líneas facturables y ninguna con problemas de stock o disponibilidad. */
  canCheckout: boolean;
  lastActivityAt: Date | null;
}

/** Ítems sueltos a cotizar sin carrito persistido (pedidos asistidos del backoffice). */
export interface CartDraft {
  tenantId: string;
  /** Cliente registrado (límites de cupón por cliente, promociones de primera compra). */
  userId: string | null;
  email?: string | null;
  items: { variantId: string; quantity: number }[];
  couponCodes?: string[];
}

/** Resultado para el controller: la vista y qué hacer con la cookie del invitado. */
export interface CartOutcome {
  cart: CartView;
  /** Token nuevo: poner la cookie. */
  setGuestToken?: string;
  /** La cookie ya no sirve (fusionada, vencida o de otro tenant): borrarla. */
  clearGuestToken?: boolean;
}

const EMPTY_TOTALS: CartTotals = {
  itemCount: 0,
  subtotal: '0.00',
  discountTotal: '0.00',
  taxableBase: '0.00',
  taxTotal: '0.00',
  total: '0.00',
};

interface Resolved {
  cart: Cart | null;
  setGuestToken?: string;
  clearGuestToken?: boolean;
}

@Injectable()
export class CartService {
  constructor(
    private readonly db: Database,
    private readonly carts: CartRepository,
    private readonly catalog: CatalogApi,
    private readonly inventory: InventoryApi,
    private readonly promotions: PromotionsApi,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // -------------------------------------------------------------------------------------
  // Casos de uso
  // -------------------------------------------------------------------------------------

  /** Si llega un cliente autenticado con cookie de invitado, primero fusiona. */
  async get(owner: CartOwner): Promise<CartOutcome> {
    if (owner.userId && owner.guestToken !== null) return this.merge({ ...owner, userId: owner.userId });
    const resolved = await this.resolve(this.db, owner, { create: false, lock: false });
    return this.outcome(resolved);
  }

  /** Suma unidades validando que existan, se vendan y alcance el stock (total de la línea). */
  async addItem(owner: CartOwner, variantId: string, quantity: number): Promise<CartOutcome> {
    const { variant, available } = await this.sellable(owner.tenantId, variantId);
    return this.mutate(owner, { create: true }, async (cart) => {
      const requested = cart.quantityOf(variantId) + quantity;
      if (requested > available) throw new CartInsufficientStockError(variantId, requested, available);
      cart.addItem(variantId, quantity, variant.price);
    });
  }

  async setQuantity(owner: CartOwner, variantId: string, quantity: number): Promise<CartOutcome> {
    const { available } = await this.sellable(owner.tenantId, variantId);
    return this.mutate(owner, { create: false }, async (cart) => {
      // Bajar la cantidad siempre se permite, aunque siga por encima del stock.
      if (quantity > cart.quantityOf(variantId) && quantity > available) {
        throw new CartInsufficientStockError(variantId, quantity, available);
      }
      cart.setQuantity(variantId, quantity);
    });
  }

  removeItem(owner: CartOwner, variantId: string): Promise<CartOutcome> {
    return this.mutate(owner, { create: false }, async (cart) => cart.removeItem(variantId));
  }

  /**
   * Agrega el cupón solo si el motor lo acepta con el carrito actual; si no, 422 con el motivo
   * (COUPON_NOT_FOUND, CONDITIONS_NOT_MET, NOT_COMBINABLE, COUPON_CUSTOMER_LIMIT, ...).
   * Un cupón ya guardado que deja de aplicar (el cliente quitó productos) queda en el carrito
   * con applied=false y su motivo, para que el cliente entienda por qué.
   */
  addCoupon(owner: CartOwner, code: string): Promise<CartOutcome> {
    return this.mutate(owner, { create: true }, async (cart) => {
      const normalized = cart.addCoupon(code);
      const pricing = await this.price(cart);
      const rejection = pricing.pricing.rejectedCoupons.find((r) => r.code === normalized);
      if (rejection) throw new CouponRejectedError(rejection.reason, rejection.message, { code: normalized, ...rejection.details });
    });
  }

  removeCoupon(owner: CartOwner, code: string): Promise<CartOutcome> {
    return this.mutate(owner, { create: false }, async (cart) => cart.removeCoupon(code));
  }

  setContact(owner: CartOwner, contact: { email?: string | null; phone?: string | null }): Promise<CartOutcome> {
    return this.mutate(owner, { create: true }, async (cart) => cart.setContact(contact));
  }

  /** El cliente vio el aviso de cambio de precio y lo acepta. */
  acknowledgePrices(owner: CartOwner): Promise<CartOutcome> {
    return this.mutate(owner, { create: false }, async (cart) => {
      const variants = await this.catalog.getSellableVariants(cart.tenantId, cart.items.map((i) => i.variantId));
      cart.acknowledgePrices(new Map([...variants.values()].map((v) => [v.variantId, v.price])));
    });
  }

  /** Para IAM (login) y POST /cart/merge: fusiona el carrito del invitado en el del usuario. */
  async merge(owner: CartOwner & { userId: string }): Promise<CartOutcome> {
    const resolved = await this.db.withTransaction(async (tx) => {
      const r = await this.resolve(tx, owner, { create: false, lock: true });
      if (r.cart) await this.carts.save(tx, r.cart);
      return r;
    });
    return this.outcome(resolved);
  }

  /** Checkout: vista con precios del carrito por id (con el envío ya cotizado, si se pasa). */
  async priceById(tenantId: string, cartId: string, shippingTotal?: string): Promise<CartView> {
    const cart = await this.carts.findById(this.db, tenantId, cartId);
    if (!cart) throw new CartNotFoundError({ cartId });
    return this.view(cart, shippingTotal);
  }

  /**
   * Pedidos asistidos (backoffice): cotiza ítems sueltos con las MISMAS reglas que un carrito
   * (precios vigentes, stock, promociones, cupones e IVA) sin guardar nada. El carrito borrador
   * vive solo en memoria: no se inserta en sales.carts ni deja rastro de abandono.
   * Respeta los límites del carrito (unidades por línea, líneas, cupones): 422 si se exceden.
   */
  async priceDraft(draft: CartDraft, shippingTotal?: string): Promise<CartView> {
    const cart = draft.userId ? Cart.forUser(draft.tenantId, draft.userId) : Cart.forGuest(draft.tenantId, generateGuestToken().hash);
    const variants = await this.catalog.getSellableVariants(draft.tenantId, draft.items.map((i) => i.variantId));
    for (const item of draft.items) {
      // Un precio igual al vigente: el borrador no tiene "precio al agregar" que pueda haber cambiado.
      cart.addItem(item.variantId, item.quantity, variants.get(item.variantId)?.price ?? '0.00');
    }
    if (draft.email) cart.setContact({ email: draft.email });
    for (const code of draft.couponCodes ?? []) cart.addCoupon(code);
    return this.view(cart, shippingTotal);
  }

  /**
   * Checkout: carrito activo del dueño con la fila BLOQUEADA hasta el fin de la transacción del
   * checkout (debe llamarse dentro de ella). Así nadie agrega ni quita ítems mientras se cobra.
   * Un cliente autenticado usa su carrito; la cookie de invitado solo cuenta sin usuario.
   */
  async lockForCheckout(owner: CartOwner): Promise<string> {
    if (!this.db.inTransaction()) throw new Error('lockForCheckout debe llamarse dentro de una transacción');
    return this.activeCartId(owner, true);
  }

  /**
   * Id del carrito activo del dueño (mismas reglas que lockForCheckout). Sin bloqueo: para
   * cotizar el envío antes de pagar, fuera de toda transacción.
   */
  async activeCartId(owner: CartOwner, forUpdate = false): Promise<string> {
    const token = this.guestToken(owner);
    const lock = { forUpdate };
    const cart = owner.userId
      ? await this.carts.findActiveByUser(this.db, owner.tenantId, owner.userId, lock)
      : token
        ? await this.carts.findActiveByGuestToken(this.db, owner.tenantId, hashGuestToken(token), this.guestActiveSince(), lock)
        : null;
    if (!cart) throw new CartNotFoundError();
    return cart.id;
  }

  /** Checkout: el pedido se creó, el carrito deja de estar activo. */
  async markConverted(tenantId: string, cartId: string): Promise<void> {
    await this.db.withTransaction(async (tx) => {
      const cart = await this.carts.findById(tx, tenantId, cartId, { forUpdate: true });
      if (!cart) throw new CartNotFoundError({ cartId });
      if (cart.status !== 'active') return;
      cart.markConverted();
      await this.carts.save(tx, cart);
    });
  }

  // -------------------------------------------------------------------------------------
  // Internos
  // -------------------------------------------------------------------------------------

  private async sellable(tenantId: string, variantId: string) {
    const [variants, availability] = await Promise.all([
      this.catalog.getSellableVariants(tenantId, [variantId]),
      this.inventory.getAvailability(tenantId, [variantId]),
    ]);
    const variant = variants.get(variantId);
    if (!variant) throw new VariantNotFoundError(variantId);
    if (!variant.purchasable) throw new VariantUnavailableError(variantId);
    return { variant, available: availability.get(variantId) ?? 0 };
  }

  private guestToken(owner: CartOwner): string | null {
    return isWellFormedGuestToken(owner.guestToken) ? owner.guestToken : null;
  }

  private guestActiveSince(): Date {
    return new Date(Date.now() - this.config.guestCartTtlDays * 24 * 60 * 60 * 1000);
  }

  /**
   * Toda modificación: en una transacción, con la fila del carrito bloqueada (FOR UPDATE), así
   * dos pestañas que agregan a la vez no se pisan. Un error dentro de fn revierte todo.
   */
  private async mutate(owner: CartOwner, opts: { create: boolean }, fn: (cart: Cart) => Promise<void>): Promise<CartOutcome> {
    const resolved = await this.db.withTransaction(async (tx) => {
      const r = await this.resolve(tx, owner, { create: opts.create, lock: true });
      if (!r.cart) throw new CartNotFoundError();
      await fn(r.cart);
      r.cart.touch();
      await this.carts.save(tx, r.cart);
      return r;
    });
    return this.outcome(resolved);
  }

  /**
   * Encuentra (y si hace falta crea) el carrito del dueño.
   *  - Cliente con cookie de invitado: fusiona el carrito del invitado en el suyo y pide borrar
   *    la cookie. Orden de bloqueo: invitado y luego usuario.
   *  - Cliente sin cookie: su carrito activo.
   *  - Invitado: el carrito de su cookie, si sigue activo y no venció; si no, uno nuevo con
   *    token nuevo (y la cookie vieja se reemplaza).
   */
  private async resolve(q: Queryable, owner: CartOwner, opts: { create: boolean; lock: boolean }): Promise<Resolved> {
    const token = this.guestToken(owner);
    const lock = { forUpdate: opts.lock };
    const guest = token
      ? await this.carts.findActiveByGuestToken(q, owner.tenantId, hashGuestToken(token), this.guestActiveSince(), lock)
      : null;
    const staleCookie = owner.guestToken !== null && !guest;

    if (owner.userId) {
      let cart = await this.carts.findActiveByUser(q, owner.tenantId, owner.userId, lock);
      if (!cart && (opts.create || guest)) cart = await this.createUserCart(q, owner.tenantId, owner.userId);
      if (cart && guest) {
        cart.absorb(guest);
        await this.carts.save(q, guest);
      }
      return { cart, clearGuestToken: owner.guestToken !== null ? true : undefined };
    }

    if (guest) return { cart: guest };
    if (!opts.create) return { cart: null, clearGuestToken: staleCookie || undefined };
    const fresh = generateGuestToken();
    const cart = Cart.forGuest(owner.tenantId, fresh.hash);
    await this.carts.insert(q, cart);
    return { cart, setGuestToken: fresh.token };
  }

  /** Si otra petición del mismo usuario lo creó en paralelo, se usa ese (índice único parcial). */
  private async createUserCart(q: Queryable, tenantId: string, userId: string): Promise<Cart> {
    const cart = Cart.forUser(tenantId, userId);
    if (await this.carts.insert(q, cart)) return cart;
    const existing = await this.carts.findActiveByUser(q, tenantId, userId, { forUpdate: true });
    if (!existing) throw new Error('Carrito activo del usuario no encontrado tras conflicto de inserción');
    return existing;
  }

  private async outcome(r: Resolved): Promise<CartOutcome> {
    return {
      cart: r.cart ? await this.view(r.cart) : emptyView(),
      setGuestToken: r.setGuestToken,
      clearGuestToken: r.clearGuestToken,
    };
  }

  /** Catálogo + stock + promociones + IVA. */
  private async price(cart: Cart, shippingTotal?: string) {
    const ids = cart.items.map((i) => i.variantId);
    const [variants, availability] = await Promise.all([
      this.catalog.getSellableVariants(cart.tenantId, ids),
      this.inventory.getAvailability(cart.tenantId, ids),
    ]);
    const lines = analyzeLines(cart.items, variants, availability);
    const pricing = await this.promotions.evaluate({
      tenantId: cart.tenantId,
      userId: cart.userId,
      email: cart.contactEmail,
      couponCodes: [...cart.couponCodes],
      shippingTotal: shippingTotal ?? null,
      lines: lines
        .filter((l) => l.billable)
        .map((l) => ({
          lineId: l.item.variantId,
          variantId: l.item.variantId,
          productId: l.variant!.productId,
          categoryPath: l.variant!.categoryPath,
          brandId: l.variant!.brandId,
          quantity: l.item.quantity,
          unitPrice: l.variant!.price,
        })),
    });
    const discounts = new Map(Object.entries(pricing.lineDiscounts).map(([id, amount]) => [id, toCents(amount)]));
    return { lines, pricing, priced: priceLines(lines, discounts) };
  }

  private async view(cart: Cart, shippingTotal?: string): Promise<CartView> {
    const { pricing, priced } = await this.price(cart, shippingTotal);
    const rejectedBy = new Map<string, CouponRejection>(pricing.rejectedCoupons.map((r) => [r.code, r]));
    const appliedBy = new Map(pricing.applied.filter((a) => a.couponCode).map((a) => [a.couponCode!, a]));
    const p = cart.toJSON();
    return {
      id: p.id,
      guest: p.userId === null,
      currency: p.currency,
      contactEmail: p.contactEmail,
      items: priced.items,
      coupons: p.couponCodes.map((code) => {
        const applied = appliedBy.get(code);
        const rejected = rejectedBy.get(code);
        return {
          code,
          applied: Boolean(applied),
          discount: applied?.discount ?? null,
          reason: rejected?.reason ?? null,
          message: rejected?.message ?? null,
        };
      }),
      promotions: pricing.applied.map((a) => ({
        promotionId: a.promotionId,
        name: a.name,
        type: a.type,
        couponId: a.couponId,
        couponCode: a.couponCode,
        discount: a.discount,
        freeShipping: a.freeShipping,
        shippingDiscount: a.shippingDiscount,
      })),
      hints: pricing.hints,
      totals: priced.totals,
      freeShipping: pricing.freeShipping,
      shippingDiscount: pricing.shippingDiscount,
      taxes: priced.taxes,
      hasPriceChanges: priced.items.some((i) => i.issues.some((x) => x.code === 'PRICE_CHANGED')),
      canCheckout: priced.totals.itemCount > 0 && !priced.items.some((i) => i.issues.some(isBlocking)),
      lastActivityAt: p.lastActivityAt,
    };
  }
}

function emptyView(): CartView {
  return {
    id: null,
    guest: true,
    currency: 'USD',
    contactEmail: null,
    items: [],
    coupons: [],
    promotions: [],
    hints: [],
    totals: { ...EMPTY_TOTALS },
    freeShipping: false,
    shippingDiscount: '0.00',
    taxes: [],
    hasPriceChanges: false,
    canCheckout: false,
    lastActivityAt: null,
  };
}
