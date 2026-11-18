import type { CartLineView } from '../../cart';
import type { SellableVariant } from '../../catalog';
import {
  CartNotReadyError,
  giftCardAmount,
  parcelOf,
  RESERVATION_DEFAULT_SECONDS,
  RESERVATION_MAX_SECONDS,
  reservationTtlSeconds,
  sourceWarehouse,
  toOrderItems,
} from './checkout';

function line(overrides: Partial<CartLineView> = {}): CartLineView {
  return {
    variantId: 'v1',
    productId: 'p1',
    sku: 'SKU-1',
    productName: 'Blusa lino',
    brandName: null,
    categoryPath: 'mujer/blusas',
    colorName: 'Blanco',
    sizeCode: 'M',
    quantity: 2,
    availableQuantity: 10,
    unitPrice: '20.00',
    priceAtAdd: '20.00',
    compareAtPrice: null,
    subtotal: '40.00',
    discount: '4.00',
    taxCode: '4',
    taxRate: '15.00',
    taxAmount: '5.40',
    total: '41.40',
    billable: true,
    issues: [],
    ...overrides,
  };
}

describe('checkout (dominio)', () => {
  it('paquete: peso y volumen de las líneas facturables', () => {
    const variant = (weightG: number, dims: [number, number, number] | null) =>
      ({ weightG, lengthMm: dims?.[0] ?? null, widthMm: dims?.[1] ?? null, heightMm: dims?.[2] ?? null }) as SellableVariant;
    const variants = new Map([
      ['v1', variant(300, [300, 200, 50])],
      ['v2', variant(900, null)],
      ['v3', variant(5000, [100, 100, 100])],
    ]);
    const items = [line({ variantId: 'v1', quantity: 2 }), line({ variantId: 'v2', quantity: 1 }), line({ variantId: 'v3', billable: false })];
    // 2 × 300 g + 900 g; 2 × 3000 cm³ (v2 sin dimensiones, v3 no facturable)
    expect(parcelOf(items, variants)).toEqual({ weightG: 1500, volumeCm3: 6000 });
  });

  it('la reserva dura más que el pago (también el enlace asistido de 24 h), con tope de 72 h + margen', () => {
    expect(reservationTtlSeconds(15 * 60)).toBe(25 * 60);
    expect(reservationTtlSeconds(24 * 3600)).toBe(24 * 3600 + 10 * 60);
    expect(reservationTtlSeconds(72 * 3600)).toBe(RESERVATION_MAX_SECONDS);
    expect(reservationTtlSeconds(100 * 3600)).toBe(RESERVATION_MAX_SECONDS);
    expect(reservationTtlSeconds(null)).toBe(RESERVATION_DEFAULT_SECONDS);
  });

  it('la gift card cubre su saldo sin pasar del total', () => {
    expect(giftCardAmount(4600, '10.00')).toBe(1000);
    expect(giftCardAmount(4600, '80.00')).toBe(4600);
  });

  it('arma las líneas del pedido con snapshots y la bodega si es única', () => {
    const items = toOrderItems(
      [line(), line({ variantId: 'v2', productId: 'p2', sku: 'SKU-2', quantity: 3, discount: null })],
      [
        { variantId: 'v1', warehouseId: 'wA', quantity: 2 },
        { variantId: 'v2', warehouseId: 'wA', quantity: 1 },
        { variantId: 'v2', warehouseId: 'wB', quantity: 2 },
      ],
      new Map([['v1', '8.00']]),
    );
    expect(items[0]).toMatchObject({ variantId: 'v1', sku: 'SKU-1', unitPrice: '20.00', discount: '4.00', taxRate: '15.00', unitCost: '8.00', warehouseId: 'wA' });
    expect(items[1]).toMatchObject({ variantId: 'v2', discount: '0.00', unitCost: null, warehouseId: null });
  });

  it('una línea sin precio o no facturable no entra a un pedido', () => {
    expect(() => toOrderItems([line({ billable: false })], [], new Map())).toThrow(CartNotReadyError);
  });

  it('bodega de origen: la única de la asignación', () => {
    expect(sourceWarehouse([{ variantId: 'v1', warehouseId: 'wA', quantity: 1 }])).toBe('wA');
    expect(
      sourceWarehouse([
        { variantId: 'v1', warehouseId: 'wA', quantity: 1 },
        { variantId: 'v2', warehouseId: 'wB', quantity: 1 },
      ]),
    ).toBeNull();
  });
});
