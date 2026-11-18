import { toCents } from '../../../shared-kernel';

export const MAX_WISHLIST_ITEMS = 100;

export type WishlistAlert = 'back_in_stock' | 'price_drop';

/** Estado guardado de un ítem (crm.wishlist_items). */
export interface WishlistState {
  notifyBackInStock: boolean;
  notifyPriceDrop: boolean;
  /** Precio visto la última vez (sin IVA), null si nunca se observó. */
  lastKnownPrice: string | null;
  lastKnownInStock: boolean | null;
  lastAlertedAt: Date | null;
}

/** Lo que se observa ahora en Catálogo + Inventario. */
export interface WishlistObservation {
  /** Precio vigente sin IVA (el menor de las variantes si el ítem es de producto). null si no hay variantes vendibles. */
  price: string | null;
  /** Hay stock disponible y el producto se puede vender. */
  inStock: boolean;
}

export interface AlertRules {
  /** Baja mínima para avisar, en puntos básicos (500 = 5 %). */
  minDropBp: number;
  /** Tras un aviso, no se manda otro del mismo ítem durante este tiempo. */
  cooldownMs: number;
}

export interface WishlistEvaluation {
  alerts: WishlistAlert[];
  /** Estado a guardar. */
  next: { lastKnownPrice: string | null; lastKnownInStock: boolean; lastAlertedAt: Date | null };
}

/**
 * Decide qué avisar al comparar lo observado con lo guardado:
 *  - back_in_stock: estaba agotado (false, no null: null = primera observación) y ahora hay stock.
 *  - price_drop: el precio bajó al menos minDropBp respecto del último visto y hay stock (avisar
 *    una rebaja de algo que no se puede comprar solo frustra).
 * Durante el enfriamiento no se avisa y se conserva la referencia anterior (precio y "agotado"),
 * así una rebaja o reposición que sigue vigente se avisa cuando termina. Una subida de precio sí
 * actualiza la referencia: la próxima baja se mide desde el precio más alto visto.
 */
export function evaluateWishlistItem(state: WishlistState, now: WishlistObservation, rules: AlertRules, at: Date): WishlistEvaluation {
  const coolingDown = state.lastAlertedAt !== null && at.getTime() - state.lastAlertedAt.getTime() < rules.cooldownMs;

  const restocked = state.lastKnownInStock === false && now.inStock;
  const dropped =
    state.lastKnownPrice !== null &&
    now.price !== null &&
    now.inStock &&
    toCents(now.price) * 10_000 <= toCents(state.lastKnownPrice) * (10_000 - rules.minDropBp) &&
    toCents(now.price) < toCents(state.lastKnownPrice);

  const wanted: WishlistAlert[] = [];
  if (restocked && state.notifyBackInStock) wanted.push('back_in_stock');
  if (dropped && state.notifyPriceDrop) wanted.push('price_drop');

  if (coolingDown && wanted.length > 0) {
    return {
      alerts: [],
      next: {
        lastKnownInStock: restocked && state.notifyBackInStock ? false : now.inStock,
        lastKnownPrice: dropped && state.notifyPriceDrop ? state.lastKnownPrice : (now.price ?? state.lastKnownPrice),
        lastAlertedAt: state.lastAlertedAt,
      },
    };
  }
  return {
    alerts: wanted,
    next: {
      lastKnownInStock: now.inStock,
      lastKnownPrice: now.price ?? state.lastKnownPrice,
      lastAlertedAt: wanted.length > 0 ? at : state.lastAlertedAt,
    },
  };
}
