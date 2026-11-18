import jwt from 'jsonwebtoken';
import { signAccessToken, verifyAccessToken } from './auth/auth-user';
import { buildSetClause } from './database/sql';
import { ValidationError } from './errors/domain-error';
import { fromCents, toCents } from './money';
import { connectionFromUrl } from './queue/queue.module';
import { formatRate, ivaCents, ivaRateBp, UnknownTaxCodeError } from './tax';

describe('money', () => {
  it('convierte a centavos y de vuelta', () => {
    expect(toCents('12.5')).toBe(1250);
    expect(toCents('0.10')).toBe(10);
    expect(toCents(19.9)).toBe(1990);
    expect(fromCents(1250)).toBe('12.50');
    expect(fromCents(5)).toBe('0.05');
    expect(fromCents(toCents('0.1') + toCents('0.2'))).toBe('0.30');
  });

  it.each(['-1', '1.234', 'abc', ''])('rechaza %p', (v) => {
    expect(() => toCents(v)).toThrow(ValidationError);
  });
});

describe('access token', () => {
  const secret = 'secreto';
  const user = { id: 'u1', tenantId: 't1', type: 'staff' as const, permissions: ['inventory.adjust'] };

  it('firma y verifica', () => {
    expect(verifyAccessToken(signAccessToken(user, secret), secret)).toEqual(user);
  });

  it('rechaza otra firma, expirados y alg=none', () => {
    expect(() => verifyAccessToken(signAccessToken(user, 'otro'), secret)).toThrow();
    expect(() => verifyAccessToken(signAccessToken(user, secret, -10), secret)).toThrow();
    const unsigned = jwt.sign({ sub: 'u1', tid: 't1', typ: 'staff', perms: ['*'] }, '', { algorithm: 'none' });
    expect(() => verifyAccessToken(unsigned, secret)).toThrow();
  });
});

describe('buildSetClause', () => {
  it('ignora undefined, escribe null y serializa objetos', () => {
    expect(
      buildSetClause({ name: 'X', city: undefined, bin: null, address: { a: 1 } }, { name: 'name', city: 'city', bin: 'bin_location', address: 'address' }, 3),
    ).toEqual({ sql: 'name = $3, bin_location = $4, address = $5', values: ['X', null, '{"a":1}'] });
  });
});

describe('connectionFromUrl', () => {
  it('interpreta VALKEY_URL', () => {
    expect(connectionFromUrl('redis://:clave%40x@valkey:6380/2')).toMatchObject({
      host: 'valkey',
      port: 6380,
      password: 'clave@x',
      db: 2,
      maxRetriesPerRequest: null,
    });
  });
});

describe('IVA por código SRI', () => {
  it('tarifas vigentes e históricas', () => {
    expect(ivaRateBp('4')).toBe(1500);
    expect(ivaRateBp('0')).toBe(0);
    expect(ivaRateBp('5')).toBe(500);
    expect(ivaRateBp('2')).toBe(1200);
    expect(ivaRateBp('6')).toBe(0); // no objeto
    expect(ivaRateBp('7')).toBe(0); // exento
    expect(() => ivaRateBp('8')).toThrow(UnknownTaxCodeError);
  });

  it('redondea al centavo, mitad hacia arriba', () => {
    expect(ivaCents(3999, 1500)).toBe(600); // 5.9985
    expect(ivaCents(3582, 1500)).toBe(537); // 5.373
    expect(ivaCents(1, 1500)).toBe(0); // 0.15 centavos
    expect(ivaCents(10, 500)).toBe(1); // 0.5 centavos → 1
    expect(formatRate(1500)).toBe('15.00');
    expect(formatRate(0)).toBe('0.00');
  });
});

describe('requestHash (idempotencia)', () => {
  it('no depende del orden de las claves ni de los campos undefined', () => {
    const { requestHash } = jest.requireActual('./idempotency/idempotency') as typeof import('./idempotency/idempotency');
    const a = requestHash({ customer: { name: 'Ana', email: 'a@x.ec' }, paymentMethod: 'card', notes: undefined });
    const b = requestHash({ paymentMethod: 'card', customer: { email: 'a@x.ec', name: 'Ana' } });
    expect(a.equals(b)).toBe(true);
    expect(a.equals(requestHash({ paymentMethod: 'cod', customer: { email: 'a@x.ec', name: 'Ana' } }))).toBe(false);
  });
});
