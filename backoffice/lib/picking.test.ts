import { describe, expect, it } from 'vitest';
import {
  adjustPick,
  completeBody,
  loadPicked,
  pickErrorLines,
  type PickingItem,
  pickProgress,
  registerPick,
  sanitizePicked,
  savePicked,
} from './picking';

const item = (id: string, barcode: string | null, quantity: number, sku = `SKU-${id}`): PickingItem => ({
  orderItemId: id,
  variantId: `v-${id}`,
  sku,
  barcode,
  productName: `Prenda ${id}`,
  color: 'Azul',
  size: 'M',
  quantity,
  imageUrl: null,
});

const items = [item('a', '7861234567890', 2), item('b', null, 1, 'CAM-OX-M'), item('c', '96385074', 1)];

describe('registerPick', () => {
  it('suma 1 a la línea cuyo código coincide', () => {
    const r = registerPick(items, {}, ' 7861234567890\r');
    expect(r.kind).toBe('ok');
    expect(r.kind === 'ok' && r.picked).toEqual({ a: 1 });
  });

  it('código que no es del pedido', () => {
    expect(registerPick(items, {}, '0000000000000')).toEqual({ kind: 'not_in_order' });
  });

  it('escanear de más en una línea completa', () => {
    const r = registerPick(items, { a: 2 }, '7861234567890');
    expect(r.kind).toBe('excess');
  });

  it('sin código de barras se reconoce por SKU (sin distinguir mayúsculas)', () => {
    const r = registerPick(items, {}, 'cam-ox-m');
    expect(r.kind === 'ok' && r.item.orderItemId).toBe('b');
  });

  it('dos líneas con el mismo código: llena la primera y sigue con la segunda', () => {
    const dup = [item('x', '111', 1), item('y', '111', 1)];
    const r1 = registerPick(dup, {}, '111');
    expect(r1.kind === 'ok' && r1.item.orderItemId).toBe('x');
    const r2 = registerPick(dup, { x: 1 }, '111');
    expect(r2.kind === 'ok' && r2.item.orderItemId).toBe('y');
    expect(registerPick(dup, { x: 1, y: 1 }, '111').kind).toBe('excess');
  });
});

describe('ajuste manual y progreso', () => {
  it('+/- acotado a [0, pedido]', () => {
    expect(adjustPick(items, {}, 'b', +1)).toEqual({ b: 1 });
    expect(adjustPick(items, { b: 1 }, 'b', +1)).toEqual({ b: 1 });
    expect(adjustPick(items, { b: 1 }, 'b', -5)).toEqual({ b: 0 });
    expect(adjustPick(items, {}, 'zz', +1)).toEqual({});
  });

  it('progreso total y completo solo con todo recogido', () => {
    expect(pickProgress(items, { a: 1 })).toMatchObject({ total: 4, done: 1, complete: false });
    expect(pickProgress(items, { a: 2, b: 1, c: 1 })).toMatchObject({ total: 4, done: 4, complete: true, ratio: 1 });
    expect(pickProgress(items, { a: 5, b: 1, c: 1 }).done).toBe(4);
  });

  it('cuerpo de completar con todas las líneas', () => {
    expect(completeBody(items, { a: 2, c: 1 })).toEqual({
      items: [
        { orderItemId: 'a', pickedQuantity: 2 },
        { orderItemId: 'b', pickedQuantity: 0 },
        { orderItemId: 'c', pickedQuantity: 1 },
      ],
    });
  });

  it('sanea lo guardado contra el detalle actual', () => {
    expect(sanitizePicked(items, { a: 9, vieja: 3, b: -1 })).toEqual({ a: 2 });
  });
});

describe('errores 422 del cierre', () => {
  it('describe sobrantes y faltantes con el nombre de la prenda', () => {
    const lines = pickErrorLines(items, {
      excess: [{ orderItemId: 'a', expected: 2, picked: 3 }],
      missing: [{ orderItemId: 'c', expected: 1, picked: 0 }],
    });
    expect(lines[0]).toMatch(/^Sobran 1: Prenda a talla M \(SKU-a\)/);
    expect(lines[1]).toMatch(/^Faltan 1: Prenda c/);
    expect(pickErrorLines(items, {})).toEqual([]);
  });
});

describe('persistencia en sessionStorage', () => {
  it('guarda, recupera y borra cuando no hay avance', () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    };
    savePicked('o1', { a: 1 }, storage);
    expect(loadPicked('o1', storage)).toEqual({ a: 1 });
    savePicked('o1', {}, storage);
    expect(mem.size).toBe(0);
  });

  it('tolera almacenamiento bloqueado o datos corruptos', () => {
    const broken = {
      getItem: () => {
        throw new Error('bloqueado');
      },
      setItem: () => {
        throw new Error('bloqueado');
      },
      removeItem: () => {
        throw new Error('bloqueado');
      },
    };
    expect(loadPicked('o1', broken)).toEqual({});
    expect(() => savePicked('o1', { a: 1 }, broken)).not.toThrow();
    expect(loadPicked('o1', { getItem: () => '{nope' })).toEqual({});
  });
});
