import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fromCents, toCents } from '../../../shared-kernel';
import { normalizeCouponCode } from '../../promotions';
import { CartItemNotFoundError, CartLimitError, InvalidContactError } from './errors';

/** CHECK (quantity BETWEEN 1 AND 20) de sales.cart_items. */
export const MAX_QTY_PER_LINE = 20;
export const MAX_LINES = 50;
export const MAX_COUPONS = 5;

export type CartStatus = 'active' | 'converted' | 'abandoned' | 'merged';

export interface CartItem {
  variantId: string;
  quantity: number;
  /** Precio SIN IVA que vio el cliente al agregar; sirve para avisar si cambió. */
  priceAtAdd: string;
  addedAt: Date;
}

export interface CartProps {
  id: string;
  tenantId: string;
  userId: string | null;
  /** SHA-256 del token de la cookie del invitado; el token en claro nunca se guarda. */
  guestTokenHash: Buffer | null;
  contactEmail: string | null;
  contactPhone: string | null;
  currency: string;
  couponCodes: string[];
  status: CartStatus;
  lastActivityAt: Date;
  createdAt: Date;
  items: CartItem[];
}

// ---------------------------------------------------------------------------------------
// Token del invitado (cookie httpOnly)
// ---------------------------------------------------------------------------------------

const GUEST_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes en base64url

export function generateGuestToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashGuestToken(token) };
}

export function hashGuestToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** Un valor manipulado en la cookie se trata como si no hubiera cookie. */
export function isWellFormedGuestToken(token: string | null | undefined): token is string {
  return typeof token === 'string' && GUEST_TOKEN_RE.test(token);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9 ]{7,20}$/;

/**
 * Carrito: de un usuario (user_id) o de un invitado (guest_token_hash). Todas las reglas que
 * no dependen de otros módulos viven aquí: límites, cupones, contacto y fusión.
 * Stock y precios vigentes los aporta la capa de aplicación (Catálogo e Inventario).
 */
export class Cart {
  private constructor(private props: CartProps) {}

  static forUser(tenantId: string, userId: string, now = new Date()): Cart {
    return Cart.create(tenantId, { userId, guestTokenHash: null }, now);
  }

  static forGuest(tenantId: string, guestTokenHash: Buffer, now = new Date()): Cart {
    return Cart.create(tenantId, { userId: null, guestTokenHash }, now);
  }

  private static create(tenantId: string, owner: Pick<CartProps, 'userId' | 'guestTokenHash'>, now: Date): Cart {
    return new Cart({
      id: randomUUID(),
      tenantId,
      ...owner,
      contactEmail: null,
      contactPhone: null,
      currency: 'USD',
      couponCodes: [],
      status: 'active',
      lastActivityAt: now,
      createdAt: now,
      items: [],
    });
  }

  static restore(props: CartProps): Cart {
    return new Cart({ ...props, couponCodes: [...props.couponCodes], items: props.items.map((i) => ({ ...i })) });
  }

  get id(): string {
    return this.props.id;
  }
  get tenantId(): string {
    return this.props.tenantId;
  }
  get userId(): string | null {
    return this.props.userId;
  }
  get items(): readonly CartItem[] {
    return this.props.items;
  }
  get couponCodes(): readonly string[] {
    return this.props.couponCodes;
  }
  get contactEmail(): string | null {
    return this.props.contactEmail;
  }
  get status(): CartStatus {
    return this.props.status;
  }

  toJSON(): CartProps {
    return { ...this.props, couponCodes: [...this.props.couponCodes], items: this.props.items.map((i) => ({ ...i })) };
  }

  quantityOf(variantId: string): number {
    return this.props.items.find((i) => i.variantId === variantId)?.quantity ?? 0;
  }

  touch(now = new Date()): void {
    this.props.lastActivityAt = now;
  }

  /**
   * Suma unidades a la línea (o la crea). priceAtAdd pasa a ser el precio actual: el cliente
   * acaba de verlo en la ficha del producto. Devuelve la cantidad resultante.
   */
  addItem(variantId: string, quantity: number, currentPrice: string, now = new Date()): number {
    assertQuantity(quantity);
    const existing = this.props.items.find((i) => i.variantId === variantId);
    const next = (existing?.quantity ?? 0) + quantity;
    if (next > MAX_QTY_PER_LINE) {
      throw new CartLimitError('CART_QUANTITY_LIMIT', `Máximo ${MAX_QTY_PER_LINE} unidades por producto`, {
        variantId,
        max: MAX_QTY_PER_LINE,
      });
    }
    const price = fromCents(toCents(currentPrice));
    if (existing) {
      existing.quantity = next;
      existing.priceAtAdd = price;
    } else {
      if (this.props.items.length >= MAX_LINES) {
        throw new CartLimitError('CART_TOO_MANY_LINES', `El carrito admite hasta ${MAX_LINES} productos distintos`);
      }
      this.props.items.push({ variantId, quantity, priceAtAdd: price, addedAt: now });
    }
    return next;
  }

  setQuantity(variantId: string, quantity: number): void {
    assertQuantity(quantity);
    if (quantity > MAX_QTY_PER_LINE) {
      throw new CartLimitError('CART_QUANTITY_LIMIT', `Máximo ${MAX_QTY_PER_LINE} unidades por producto`, {
        variantId,
        max: MAX_QTY_PER_LINE,
      });
    }
    const item = this.props.items.find((i) => i.variantId === variantId);
    if (!item) throw new CartItemNotFoundError(variantId);
    item.quantity = quantity;
  }

  removeItem(variantId: string): void {
    const before = this.props.items.length;
    this.props.items = this.props.items.filter((i) => i.variantId !== variantId);
    if (this.props.items.length === before) throw new CartItemNotFoundError(variantId);
  }

  /** Devuelve el código normalizado. Repetir un código no lo duplica. */
  addCoupon(code: string): string {
    const normalized = normalizeCouponCode(code);
    if (this.props.couponCodes.includes(normalized)) return normalized;
    if (this.props.couponCodes.length >= MAX_COUPONS) {
      throw new CartLimitError('CART_TOO_MANY_COUPONS', `Puedes usar hasta ${MAX_COUPONS} cupones`);
    }
    this.props.couponCodes.push(normalized);
    return normalized;
  }

  removeCoupon(code: string): void {
    const normalized = normalizeCouponCode(code);
    this.props.couponCodes = this.props.couponCodes.filter((c) => c !== normalized);
  }

  /** Contacto para recordatorios de carrito abandonado y para identificar al invitado. */
  setContact(contact: { email?: string | null; phone?: string | null }): void {
    if (contact.email !== undefined) {
      const email = contact.email?.trim().toLowerCase() || null;
      if (email && !EMAIL_RE.test(email)) throw new InvalidContactError('Email inválido');
      this.props.contactEmail = email;
    }
    if (contact.phone !== undefined) {
      const phone = contact.phone?.trim() || null;
      if (phone && !PHONE_RE.test(phone)) throw new InvalidContactError('Teléfono inválido');
      this.props.contactPhone = phone;
    }
  }

  /** El cliente aceptó los precios nuevos: priceAtAdd = precio vigente y desaparece el aviso. */
  acknowledgePrices(currentPrices: Map<string, string>): void {
    for (const item of this.props.items) {
      const price = currentPrices.get(item.variantId);
      if (price !== undefined) item.priceAtAdd = fromCents(toCents(price));
    }
  }

  /**
   * Fusión al iniciar sesión: el carrito del invitado se vuelca en este (el del usuario).
   *  - Misma variante: se suman las cantidades hasta el máximo por línea; se conserva el
   *    priceAtAdd del usuario (el aviso de cambio de precio sigue siendo correcto).
   *  - Variante nueva: se agrega con su priceAtAdd, mientras quepa en MAX_LINES.
   *  - Cupones: unión sin repetidos, hasta MAX_COUPONS. Contacto: solo si faltaba.
   * El stock no se valida aquí (no se puede fallar un login por eso): la vista del carrito
   * marcará las líneas que excedan lo disponible.
   */
  absorb(guest: Cart, now = new Date()): void {
    for (const g of guest.props.items) {
      const mine = this.props.items.find((i) => i.variantId === g.variantId);
      if (mine) {
        mine.quantity = Math.min(mine.quantity + g.quantity, MAX_QTY_PER_LINE);
        if (g.addedAt < mine.addedAt) mine.addedAt = g.addedAt;
      } else if (this.props.items.length < MAX_LINES) {
        this.props.items.push({ ...g });
      }
    }
    for (const code of guest.props.couponCodes) {
      if (!this.props.couponCodes.includes(code) && this.props.couponCodes.length < MAX_COUPONS) this.props.couponCodes.push(code);
    }
    this.props.contactEmail ??= guest.props.contactEmail;
    this.props.contactPhone ??= guest.props.contactPhone;
    this.props.lastActivityAt = now;
    guest.props.status = 'merged';
    guest.props.lastActivityAt = now;
  }

  markConverted(now = new Date()): void {
    this.props.status = 'converted';
    this.props.lastActivityAt = now;
  }
}

function assertQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new CartLimitError('CART_QUANTITY_LIMIT', 'La cantidad debe ser un entero mayor o igual a 1');
  }
}
