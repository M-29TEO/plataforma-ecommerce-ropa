import { formatRate, fromCents, IVA_RATES_BP, ivaCents, toCents } from '../../../shared-kernel';
import type { SellableVariant } from '../../catalog';
import type { CartItem } from './cart';

/**
 * Avisos por línea. Los de stock y disponibilidad bloquean el checkout; el de precio solo avisa
 * (el total ya usa el precio vigente).
 */
export type CartIssue =
  | { code: 'UNAVAILABLE'; message: string }
  | { code: 'OUT_OF_STOCK'; message: string }
  | { code: 'INSUFFICIENT_STOCK'; message: string; available: number }
  | { code: 'PRICE_CHANGED'; message: string; previousPrice: string; currentPrice: string; direction: 'up' | 'down' };

const BLOCKING: ReadonlySet<CartIssue['code']> = new Set(['UNAVAILABLE', 'OUT_OF_STOCK', 'INSUFFICIENT_STOCK']);

/** Línea ya cruzada con Catálogo e Inventario, antes de promociones e IVA. */
export interface AnalyzedLine {
  item: CartItem;
  variant: SellableVariant | null;
  available: number;
  /** Entra en los totales: se puede comprar (aunque sea con menos unidades). */
  billable: boolean;
  unitPriceCents: number | null;
  rateBp: number | null;
  issues: CartIssue[];
}

export interface CartLineView {
  variantId: string;
  productId: string | null;
  sku: string | null;
  productName: string | null;
  brandName: string | null;
  categoryPath: string | null;
  colorName: string | null;
  sizeCode: string | null;
  quantity: number;
  availableQuantity: number;
  /** Precio vigente SIN IVA. */
  unitPrice: string | null;
  priceAtAdd: string;
  compareAtPrice: string | null;
  /** Montos de la línea; null si la línea no entra en los totales. */
  subtotal: string | null;
  discount: string | null;
  taxCode: string | null;
  taxRate: string | null;
  taxAmount: string | null;
  total: string | null;
  billable: boolean;
  issues: CartIssue[];
}

export interface TaxBreakdown {
  taxCode: string;
  rate: string;
  base: string;
  amount: string;
}

export interface CartTotals {
  /** Unidades que entran en los totales. */
  itemCount: number;
  subtotal: string;
  discountTotal: string;
  /** Base imponible: subtotal − descuentos. */
  taxableBase: string;
  taxTotal: string;
  /** subtotal − descuentos + IVA. El envío se cotiza en el checkout. */
  total: string;
}

/**
 * Cruza cada ítem con el catálogo y el stock:
 *  - Sin variante, producto inactivo o código de IVA desconocido → UNAVAILABLE (fuera de totales).
 *  - Disponible 0 → OUT_OF_STOCK (fuera de totales).
 *  - Cantidad > disponible → INSUFFICIENT_STOCK (sigue en totales, pero bloquea el checkout).
 *  - Precio vigente ≠ priceAtAdd → PRICE_CHANGED (solo aviso).
 */
export function analyzeLines(
  items: readonly CartItem[],
  variants: Map<string, SellableVariant>,
  availability: Map<string, number>,
): AnalyzedLine[] {
  return items.map((item) => {
    const variant = variants.get(item.variantId) ?? null;
    const available = Math.max(availability.get(item.variantId) ?? 0, 0);
    const issues: CartIssue[] = [];
    const rateBp = variant ? (IVA_RATES_BP[variant.taxCode] ?? null) : null;

    if (!variant || !variant.purchasable || rateBp === null) {
      issues.push({ code: 'UNAVAILABLE', message: 'Este producto ya no está disponible' });
      return { item, variant, available, billable: false, unitPriceCents: null, rateBp, issues };
    }

    const unitPriceCents = toCents(variant.price);
    const previous = toCents(item.priceAtAdd);
    if (unitPriceCents !== previous) {
      const direction = unitPriceCents > previous ? 'up' : 'down';
      issues.push({
        code: 'PRICE_CHANGED',
        message: `El precio ${direction === 'up' ? 'subió' : 'bajó'} de $${item.priceAtAdd} a $${fromCents(unitPriceCents)}`,
        previousPrice: fromCents(previous),
        currentPrice: fromCents(unitPriceCents),
        direction,
      });
    }
    if (available === 0) {
      issues.push({ code: 'OUT_OF_STOCK', message: 'Agotado' });
      return { item, variant, available, billable: false, unitPriceCents, rateBp, issues };
    }
    if (item.quantity > available) {
      issues.push({ code: 'INSUFFICIENT_STOCK', message: `Solo quedan ${available} unidades`, available });
    }
    return { item, variant, available, billable: true, unitPriceCents, rateBp, issues };
  });
}

export function isBlocking(issue: CartIssue): boolean {
  return BLOCKING.has(issue.code);
}

/**
 * Montos finales. Por línea (igual que Pedidos y la factura del SRI):
 *   base = cantidad × precio − descuento;  IVA = base × tasa, redondeado al centavo (mitad arriba);
 *   total de línea = base + IVA.
 * Los totales del carrito son la suma de las líneas, así cuadran con el pedido que se creará.
 */
export function priceLines(
  lines: AnalyzedLine[],
  lineDiscounts: Map<string, number>,
): { items: CartLineView[]; totals: CartTotals; taxes: TaxBreakdown[] } {
  let itemCount = 0;
  let subtotal = 0;
  let discountTotal = 0;
  let taxTotal = 0;
  const byCode = new Map<string, { rateBp: number; base: number; amount: number }>();

  const items = lines.map((l): CartLineView => {
    const v = l.variant;
    const view: CartLineView = {
      variantId: l.item.variantId,
      productId: v?.productId ?? null,
      sku: v?.sku ?? null,
      productName: v?.productName ?? null,
      brandName: v?.brandName ?? null,
      categoryPath: v?.categoryPath ?? null,
      colorName: v?.colorName ?? null,
      sizeCode: v?.sizeCode ?? null,
      quantity: l.item.quantity,
      availableQuantity: l.available,
      unitPrice: l.unitPriceCents === null ? null : fromCents(l.unitPriceCents),
      priceAtAdd: l.item.priceAtAdd,
      compareAtPrice: v?.compareAtPrice ?? null,
      subtotal: null,
      discount: null,
      taxCode: v?.taxCode ?? null,
      taxRate: l.rateBp === null ? null : formatRate(l.rateBp),
      taxAmount: null,
      total: null,
      billable: l.billable,
      issues: l.issues,
    };
    if (!l.billable || l.unitPriceCents === null || l.rateBp === null || !v) return view;

    const gross = l.item.quantity * l.unitPriceCents;
    const discount = Math.min(lineDiscounts.get(l.item.variantId) ?? 0, gross);
    const base = gross - discount;
    const tax = ivaCents(base, l.rateBp);
    itemCount += l.item.quantity;
    subtotal += gross;
    discountTotal += discount;
    taxTotal += tax;
    const bucket = byCode.get(v.taxCode) ?? { rateBp: l.rateBp, base: 0, amount: 0 };
    bucket.base += base;
    bucket.amount += tax;
    byCode.set(v.taxCode, bucket);

    return {
      ...view,
      subtotal: fromCents(gross),
      discount: fromCents(discount),
      taxAmount: fromCents(tax),
      total: fromCents(base + tax),
    };
  });

  const taxes = [...byCode.entries()]
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([taxCode, t]) => ({ taxCode, rate: formatRate(t.rateBp), base: fromCents(t.base), amount: fromCents(t.amount) }));

  return {
    items,
    totals: {
      itemCount,
      subtotal: fromCents(subtotal),
      discountTotal: fromCents(discountTotal),
      taxableBase: fromCents(subtotal - discountTotal),
      taxTotal: fromCents(taxTotal),
      total: fromCents(subtotal - discountTotal + taxTotal),
    },
    taxes,
  };
}
