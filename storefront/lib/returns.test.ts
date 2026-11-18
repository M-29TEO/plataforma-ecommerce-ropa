import { describe, expect, it } from 'vitest';
import type { OrderDetail } from './commerce-types';
import {
  buildReturnBody,
  canRequestReturn,
  type CustomerReturn,
  daysLeftToReturn,
  emptyReturnDraft,
  exchangeSizeOptions,
  hasErrors,
  lineErrorFromApi,
  openQuantities,
  photoFileError,
  RETURN_REASON_CODES,
  RETURN_REASON_LABEL,
  RETURN_STATUS_LABEL,
  RETURN_STATUSES,
  returnableQuantity,
  returnApiMessage,
  validateReturnDraft,
} from './returns';
import type { ProductDetail } from './types';

const item = (id: string, quantity: number, qtyReturned = 0) => ({ id, variantId: `v-${id}`, colorName: 'Negro', quantity, qtyReturned });

const order = (over: Partial<OrderDetail> = {}) =>
  ({
    status: 'delivered',
    deliveredAt: '2026-10-01T15:00:00Z',
    items: [item('a', 2), item('b', 1)],
    ...over,
  }) as unknown as OrderDetail;

const ret = (status: CustomerReturn['status'], items: Array<[string, number]>) =>
  ({ status, items: items.map(([orderItemId, quantity]) => ({ orderItemId, quantity })) }) as unknown as CustomerReturn;

const NOW = new Date('2026-10-12T12:00:00Z');

describe('etiquetas de devoluciones', () => {
  it('todos los estados y motivos del API tienen etiqueta en español', () => {
    for (const s of RETURN_STATUSES) expect(RETURN_STATUS_LABEL[s]).toBeTruthy();
    for (const r of RETURN_REASON_CODES) expect(RETURN_REASON_LABEL[r]).toBeTruthy();
    expect(RETURN_STATUS_LABEL.pickup_scheduled).toBe('Retiro programado');
  });
});

describe('elegibilidad', () => {
  it('pedido entregado dentro de los 30 días: se puede solicitar', () => {
    expect(canRequestReturn(order(), [], NOW)).toBe(true);
    expect(canRequestReturn(order({ status: 'partially_returned' }), [], NOW)).toBe(true);
  });

  it('no entregado, sin fecha de entrega o fuera de plazo: no', () => {
    expect(canRequestReturn(order({ status: 'in_transit' }), [], NOW)).toBe(false);
    expect(canRequestReturn(order({ status: 'returned' }), [], NOW)).toBe(false);
    expect(canRequestReturn(order({ deliveredAt: null }), [], NOW)).toBe(false);
    expect(canRequestReturn(order({ deliveredAt: '2026-09-01T00:00:00Z' }), [], NOW)).toBe(false);
  });

  it('el último instante del plazo todavía vale', () => {
    const deliveredAt = '2026-09-12T12:00:00Z';
    expect(canRequestReturn(order({ deliveredAt }), [], NOW)).toBe(true);
    expect(daysLeftToReturn(deliveredAt, NOW)).toBe(0);
    expect(daysLeftToReturn('2026-10-01T12:00:00Z', NOW)).toBe(19);
    expect(daysLeftToReturn('2026-09-01T00:00:00Z', NOW)).toBeNull();
  });

  it('sin unidades por devolver (ya devueltas o en solicitudes abiertas): no', () => {
    const o = order({ items: [item('a', 2, 1), item('b', 1)] as OrderDetail['items'] });
    expect(canRequestReturn(o, [ret('requested', [['a', 1], ['b', 1]])], NOW)).toBe(false);
    // Una rechazada libera las unidades.
    expect(canRequestReturn(o, [ret('rejected', [['a', 1], ['b', 1]])], NOW)).toBe(true);
  });

  it('cantidad devolvible: comprada − devuelta − abierta', () => {
    const open = openQuantities([ret('approved', [['a', 1]]), ret('refunded', [['a', 1]]), ret('pickup_scheduled', [['a', 1]])]);
    expect(open.get('a')).toBe(2);
    expect(returnableQuantity(item('a', 5, 1), open)).toBe(2);
    expect(returnableQuantity(item('a', 2, 1), open)).toBe(0);
    expect(returnableQuantity({ id: 'z', quantity: 3 }, open)).toBe(3);
  });
});

describe('tallas para el cambio', () => {
  const v = (id: string, size: string, stock: string, color = 'Negro') => ({ id, size, stock, color: { name: color, hex: null } });
  const product = {
    variants: [v('v-a', 'M', 'in_stock'), v('s', 'S', 'low'), v('l', 'L', 'out_of_stock'), v('xl', 'XL', 'in_stock'), v('r', 'S', 'in_stock', 'Rojo')],
  } as unknown as ProductDetail;

  it('otras tallas del mismo color con stock, sin la comprada', () => {
    expect(exchangeSizeOptions(product, { variantId: 'v-a', colorName: 'Negro' })).toEqual([
      { variantId: 's', size: 'S', stock: 'low' },
      { variantId: 'xl', size: 'XL', stock: 'in_stock' },
    ]);
  });
});

describe('fotos', () => {
  it('solo jpg, png o webp de hasta 5 MB', () => {
    expect(photoFileError({ type: 'image/jpeg', size: 1000 })).toBeNull();
    expect(photoFileError({ type: 'image/gif', size: 1000 })).toMatch(/JPG/);
    expect(photoFileError({ type: 'image/png', size: 5 * 1024 * 1024 + 1 })).toMatch(/5 MB/);
  });
});

describe('formulario', () => {
  const available = new Map([
    ['a', 2],
    ['b', 1],
  ]);

  it('exige al menos un producto', () => {
    const errors = validateReturnDraft(emptyReturnDraft([{ id: 'a' }, { id: 'b' }]), available);
    expect(errors.form).toBeTruthy();
    expect(hasErrors(errors)).toBe(true);
  });

  it('valida cantidad, motivo, foto en motivos de la tienda y talla en cambios', () => {
    const d = emptyReturnDraft([{ id: 'a' }, { id: 'b' }]);
    d.type = 'exchange';
    d.lines[0] = { ...d.lines[0], selected: true, quantity: 3, reasonCode: 'defect' };
    d.lines[1] = { ...d.lines[1], selected: true, quantity: 1 };
    const errors = validateReturnDraft(d, available);
    expect(errors.lines.a).toEqual({ quantity: 'Puedes devolver hasta 2.', photos: expect.any(String), exchangeVariantId: 'Elige la talla nueva.' });
    expect(errors.lines.b.reasonCode).toBe('Elige el motivo.');
  });

  it('devolución válida: cuerpo sin variante y con la resolución', () => {
    const d = emptyReturnDraft([{ id: 'a' }, { id: 'b' }]);
    d.resolution = 'store_credit';
    d.customerNotes = '  Llegó roto  ';
    d.lines[0] = { ...d.lines[0], selected: true, quantity: 2, reasonCode: 'defect', photos: ['k1'], exchangeVariantId: 'x' };
    expect(hasErrors(validateReturnDraft(d, available))).toBe(false);
    expect(buildReturnBody(d)).toEqual({
      type: 'return',
      resolution: 'store_credit',
      customerNotes: 'Llegó roto',
      items: [{ orderItemId: 'a', quantity: 2, reasonCode: 'defect', photos: ['k1'] }],
    });
  });

  it('cambio: con la variante nueva y sin resolución ni fotos vacías', () => {
    const d = emptyReturnDraft([{ id: 'a' }]);
    d.type = 'exchange';
    d.lines[0] = { ...d.lines[0], selected: true, reasonCode: 'size_small', exchangeVariantId: 'v-l' };
    expect(buildReturnBody(d)).toEqual({ type: 'exchange', items: [{ orderItemId: 'a', quantity: 1, reasonCode: 'size_small', exchangeVariantId: 'v-l' }] });
  });
});

describe('errores del API', () => {
  it('ubica en su línea los errores con orderItemId', () => {
    expect(lineErrorFromApi('RETURN_QUANTITY_EXCEEDED', { orderItemId: 'a', available: 0 })).toEqual({ orderItemId: 'a', field: 'quantity' });
    expect(lineErrorFromApi('EXCHANGE_VARIANT_INVALID', { orderItemId: 'a' })).toEqual({ orderItemId: 'a', field: 'exchangeVariantId' });
    expect(lineErrorFromApi('RETURN_WINDOW_EXPIRED', { windowDays: 30 })).toBeNull();
  });

  it('mensajes propios para el plazo y el stock del cambio', () => {
    expect(returnApiMessage('RETURN_WINDOW_EXPIRED', 'x')).toMatch(/plazo/);
    expect(returnApiMessage('ALGO', 'del API')).toBe('del API');
  });
});
