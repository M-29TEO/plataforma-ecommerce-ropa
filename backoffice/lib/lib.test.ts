import { describe, expect, it } from 'vitest';
import { withQuery } from './api/client';
import { formatDate, formatMoney, formatRelative, isoDateInStore, toNumber } from './format';
import { safeNext } from './safe-redirect';
import { decodeClaims } from './token';

function fakeJwt(payload: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.firma`;
}

describe('decodeClaims', () => {
  it('lee sub, tid, typ y perms (con tildes y base64url)', () => {
    const c = decodeClaims(fakeJwt({ sub: 'u1', tid: 't1', typ: 'staff', perms: ['orders.read'], name: 'Lucía' }));
    expect(c).toEqual({ sub: 'u1', tid: 't1', typ: 'staff', perms: ['orders.read'], exp: undefined });
  });

  it('token malformado o sin claims obligatorios → null', () => {
    expect(decodeClaims('basura')).toBeNull();
    expect(decodeClaims('a.!!!.c')).toBeNull();
    expect(decodeClaims(fakeJwt({ sub: 'u1' }))).toBeNull();
  });

  it('perms ausente o con basura → solo strings', () => {
    expect(decodeClaims(fakeJwt({ sub: 'u', tid: 't', typ: 'staff' }))?.perms).toEqual([]);
    expect(decodeClaims(fakeJwt({ sub: 'u', tid: 't', typ: 'staff', perms: ['a', 1, null] }))?.perms).toEqual(['a']);
  });
});

describe('safeNext (sin open redirect)', () => {
  it.each([
    [null, '/'],
    ['/usuarios', '/usuarios'],
    ['/bodega/picking?x=1', '/bodega/picking?x=1'],
    ['https://malo.example', '/'],
    ['//malo.example', '/'],
    ['/\\malo.example', '/'],
    ['/ingresar', '/'],
    ['/a\nb', '/'],
  ])('%s → %s', (input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });
});

describe('formatos', () => {
  it('dinero en USD desde string o número', () => {
    expect(formatMoney('12.5')).toMatch(/12,50/);
    expect(formatMoney(null)).toBe('—');
    expect(toNumber('abc')).toBeNull();
  });

  it('fecha de la tienda en hora de Ecuador (UTC-5)', () => {
    expect(isoDateInStore(new Date('2026-10-08T03:00:00Z'))).toBe('2026-10-07');
  });

  it('una fecha sin hora (emisión del SRI) se muestra ese mismo día, no el anterior', () => {
    expect(formatDate('2026-10-12')).toBe(formatDate(new Date('2026-10-12T17:00:00Z')));
    expect(formatDate('2026-10-12')).toMatch(/12/);
  });

  it('tiempo relativo', () => {
    const now = new Date('2026-10-07T12:00:00Z');
    expect(formatRelative('2026-10-07T11:59:30Z', now)).toBe('hace 30 s');
    expect(formatRelative('2026-10-07T11:00:00Z', now)).toBe('hace 1 h');
  });
});

describe('withQuery', () => {
  it('omite vacíos y une arreglos con coma', () => {
    expect(withQuery('/orders', { q: '', status: ['paid', 'preparing'], limit: 20, x: undefined })).toBe('/orders?status=paid%2Cpreparing&limit=20');
    expect(withQuery('/a?b=1', { c: true })).toBe('/a?b=1&c=true');
    expect(withQuery('/a', {})).toBe('/a');
  });
});
