import { describe, expect, it } from 'vitest';
import {
  adjustmentBody,
  canCancel,
  canReceive,
  canSend,
  fillPending,
  isLowStock,
  normalizeUnitCost,
  poProgress,
  previewAdjustment,
  type PurchaseOrderItem,
  receiptLines,
  registerScan,
  setLineQty,
  stockTone,
  validReason,
} from './inventory';

const items: PurchaseOrderItem[] = [
  { id: 'i1', variantId: 'v1', qtyOrdered: 3, qtyReceived: 1, unitCost: '10.00' },
  { id: 'i2', variantId: 'v2', qtyOrdered: 2, qtyReceived: 2, unitCost: '5.50' },
  { id: 'i3', variantId: 'v3', qtyOrdered: 1, qtyReceived: 0, unitCost: '7.00' },
];

describe('recepción de órdenes de compra', () => {
  it('estados que permiten enviar, cancelar y recibir', () => {
    expect(canSend('draft')).toBe(true);
    expect(canSend('sent')).toBe(false);
    expect(canCancel('sent')).toBe(true);
    expect(canCancel('partially_received')).toBe(false);
    expect(canReceive('sent')).toBe(true);
    expect(canReceive('partially_received')).toBe(true);
    expect(canReceive('draft')).toBe(false);
    expect(canReceive('received')).toBe(false);
  });

  it('escanear suma 1 a la línea de la variante sin pasar lo pendiente', () => {
    const r1 = registerScan(items, {}, 'v1');
    expect(r1).toEqual({ kind: 'ok', itemId: 'i1', counts: { i1: 1 } });
    const r2 = registerScan(items, { i1: 1 }, 'v1');
    expect(r2.kind === 'ok' && r2.counts.i1).toBe(2);
    expect(registerScan(items, { i1: 2 }, 'v1')).toEqual({ kind: 'complete', itemId: 'i1' });
    expect(registerScan(items, {}, 'v2')).toEqual({ kind: 'complete', itemId: 'i2' });
  });

  it('avisa si la variante no está en la orden', () => {
    expect(registerScan(items, {}, 'otra')).toEqual({ kind: 'not_in_order' });
  });

  it('la cantidad tecleada se acota a [0, pendiente]', () => {
    expect(setLineQty(items, {}, 'i1', 9)).toEqual({ i1: 2 });
    expect(setLineQty(items, { i1: 2 }, 'i1', -3)).toEqual({ i1: 0 });
    expect(setLineQty(items, {}, 'i3', 1.7)).toEqual({ i3: 1 });
    expect(setLineQty(items, {}, 'nope', 1)).toEqual({});
  });

  it('arma las líneas del recibo solo con cantidades > 0', () => {
    expect(receiptLines(items, { i1: 2, i2: 0, i3: 0 })).toEqual([{ itemId: 'i1', quantity: 2 }]);
    expect(receiptLines(items, fillPending(items))).toEqual([
      { itemId: 'i1', quantity: 2 },
      { itemId: 'i3', quantity: 1 },
    ]);
  });

  it('calcula pedido, recibido, pendiente y lo que queda tras la recepción', () => {
    expect(poProgress(items, { i1: 1 })).toEqual({ ordered: 6, received: 3, pending: 3, now: 1, remainingAfter: 2 });
  });

  it('normaliza el costo unitario a 2 decimales', () => {
    expect(normalizeUnitCost('12.5')).toBe('12.50');
    expect(normalizeUnitCost('3,99')).toBe('3.99');
    expect(normalizeUnitCost('1.999')).toBeNull();
    expect(normalizeUnitCost('-1')).toBeNull();
    expect(normalizeUnitCost('')).toBeNull();
  });
});

describe('ajustes de stock', () => {
  const level = { onHand: 10, reserved: 4 };

  it('corrección con signo', () => {
    expect(previewAdjustment(level, 'adjustment', -3)).toEqual({ delta: -3, newOnHand: 7, error: null });
    expect(previewAdjustment(level, 'adjustment', 0).error).toMatch(/no puede ser 0/);
  });

  it('merma siempre resta', () => {
    expect(previewAdjustment(level, 'damage', 2)).toEqual({ delta: -2, newOnHand: 8, error: null });
    expect(previewAdjustment(level, 'damage', 0).error).not.toBeNull();
  });

  it('conteo físico calcula la diferencia (y permite delta 0)', () => {
    expect(previewAdjustment(level, 'count', 12)).toEqual({ delta: 2, newOnHand: 12, error: null });
    expect(previewAdjustment(level, 'count', 10)).toEqual({ delta: 0, newOnHand: 10, error: null });
    expect(previewAdjustment(null, 'count', 5)).toEqual({ delta: 5, newOnHand: 5, error: null });
  });

  it('rechaza dejar menos físico que lo reservado y los no enteros', () => {
    expect(previewAdjustment(level, 'adjustment', -7).error).toMatch(/reservadas/);
    expect(previewAdjustment(level, 'count', 3).error).toMatch(/reservadas/);
    expect(previewAdjustment(level, 'adjustment', 1.5).error).toMatch(/entero/);
  });

  it('arma el cuerpo según el tipo del DTO', () => {
    const base = { variantId: 'v', warehouseId: 'w', reason: ' Conteo ' };
    expect(adjustmentBody({ ...base, type: 'adjustment', qty: -2 })).toEqual({ variantId: 'v', warehouseId: 'w', type: 'adjustment', reason: 'Conteo', delta: -2 });
    expect(adjustmentBody({ ...base, type: 'damage', qty: 1 })).toMatchObject({ quantity: 1 });
    expect(adjustmentBody({ ...base, type: 'count', qty: 0 })).toMatchObject({ countedQuantity: 0 });
  });

  it('el motivo tiene de 3 a 500 caracteres', () => {
    expect(validReason('  ab ')).toBe(false);
    expect(validReason('abc')).toBe(true);
    expect(validReason('x'.repeat(501))).toBe(false);
  });
});

describe('alertas de stock', () => {
  it('stock bajo = disponible <= punto de reorden', () => {
    expect(isLowStock({ available: 5, reorderPoint: 5 })).toBe(true);
    expect(isLowStock({ available: 6, reorderPoint: 5 })).toBe(false);
    expect(stockTone({ available: 0, reorderPoint: 0 })[0]).toBe('Sin stock');
    expect(stockTone({ available: 3, reorderPoint: 5 })[0]).toBe('Stock bajo');
    expect(stockTone({ available: 9, reorderPoint: 5 })[0]).toBe('OK');
  });
});
