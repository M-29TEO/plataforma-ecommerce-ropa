import { assertPickComplete, compareQueue, comparePick, PickExcessError, PickIncompleteError } from './picking';

const LINES = [
  { orderItemId: 'a', quantity: 2 },
  { orderItemId: 'b', quantity: 1 },
];

describe('picking: validación de cantidades', () => {
  it('acepta exactamente lo pedido', () => {
    expect(() => assertPickComplete(LINES, [{ orderItemId: 'a', pickedQuantity: 2 }, { orderItemId: 'b', pickedQuantity: 1 }])).not.toThrow();
  });

  it('una línea repetida en el cuerpo suma sus cantidades', () => {
    const picked = [{ orderItemId: 'a', pickedQuantity: 1 }, { orderItemId: 'a', pickedQuantity: 1 }, { orderItemId: 'b', pickedQuantity: 1 }];
    expect(comparePick(LINES, picked)).toEqual({ missing: [], excess: [] });
  });

  it('faltantes: PICK_INCOMPLETE con el detalle por línea (las no enviadas cuentan como 0)', () => {
    let error: unknown;
    try {
      assertPickComplete(LINES, [{ orderItemId: 'a', pickedQuantity: 1 }]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PickIncompleteError);
    expect((error as PickIncompleteError).code).toBe('PICK_INCOMPLETE');
    expect((error as PickIncompleteError).details).toEqual({
      missing: [
        { orderItemId: 'a', expected: 2, picked: 1 },
        { orderItemId: 'b', expected: 1, picked: 0 },
      ],
    });
  });

  it('sobrantes: PICK_EXCESS, también por una línea que no es del pedido, y tiene prioridad sobre faltantes', () => {
    const { excess, missing } = comparePick(LINES, [
      { orderItemId: 'a', pickedQuantity: 3 },
      { orderItemId: 'zzz', pickedQuantity: 1 },
    ]);
    expect(excess).toEqual([
      { orderItemId: 'a', expected: 2, picked: 3 },
      { orderItemId: 'zzz', expected: 0, picked: 1 },
    ]);
    expect(missing).toEqual([{ orderItemId: 'b', expected: 1, picked: 0 }]);
    expect(() => assertPickComplete(LINES, [{ orderItemId: 'a', pickedQuantity: 3 }])).toThrow(PickExcessError);
  });

  it('una línea ajena con 0 unidades no es sobrante', () => {
    expect(comparePick(LINES, [{ orderItemId: 'a', pickedQuantity: 2 }, { orderItemId: 'b', pickedQuantity: 1 }, { orderItemId: 'x', pickedQuantity: 0 }]).excess).toEqual([]);
  });
});

describe('picking: orden de la cola', () => {
  const at = (iso: string) => new Date(iso);
  it('franja más próxima primero; sin franja al final por antigüedad; desempate por número', () => {
    const queue = [
      { id: 'sin-franja-viejo', slotStartsAt: null, placedAt: at('2026-10-01T10:00:00Z'), orderNumber: '5' },
      { id: 'franja-tarde', slotStartsAt: at('2026-10-07T18:00:00Z'), placedAt: at('2026-10-06T10:00:00Z'), orderNumber: '3' },
      { id: 'franja-temprano', slotStartsAt: at('2026-10-07T10:00:00Z'), placedAt: at('2026-10-06T11:00:00Z'), orderNumber: '4' },
      { id: 'sin-franja-nuevo-2', slotStartsAt: null, placedAt: at('2026-10-02T10:00:00Z'), orderNumber: '7' },
      { id: 'sin-franja-nuevo-1', slotStartsAt: null, placedAt: at('2026-10-02T10:00:00Z'), orderNumber: '6' },
    ];
    expect([...queue].sort(compareQueue).map((q) => q.id)).toEqual([
      'franja-temprano',
      'franja-tarde',
      'sin-franja-viejo',
      'sin-franja-nuevo-1',
      'sin-franja-nuevo-2',
    ]);
  });
});
