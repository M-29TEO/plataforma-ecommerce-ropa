import { cartReminderTemplate, marketingChannelsWithoutPurpose, shipmentTemplate, TEMPLATE_CATALOG } from './catalog';
import { localeCandidates } from './locale';
import { dedupeKey, isMobile, normalizeEmail, toE164 } from './recipients';
import { onFailure } from './retry';

describe('catálogo y enrutamiento', () => {
  it('ningún mensaje de marketing sale por un canal sin propósito de consentimiento (webpush, ntfy)', () => {
    expect(marketingChannelsWithoutPurpose()).toEqual([]);
  });

  it('los recordatorios de carrito son marketing; los de pedidos, transaccionales', () => {
    expect(TEMPLATE_CATALOG['cart.reminder.1h'].category).toBe('marketing');
    expect(TEMPLATE_CATALOG['order.placed'].category).toBe('transactional');
  });

  it('estados de envío: sin aviso para retiros, cancelaciones ni la entrega de un pedido (la avisa OrderDelivered)', () => {
    expect(shipmentTemplate('outbound', 'in_transit')).toBe('shipment.in_transit');
    expect(shipmentTemplate('outbound', 'arriving')).toBe('shipment.arriving');
    expect(shipmentTemplate('outbound', 'delivered')).toBeNull();
    expect(shipmentTemplate('exchange', 'delivered')).toBe('shipment.delivered');
    expect(shipmentTemplate('outbound', 'cancelled')).toBeNull();
    expect(shipmentTemplate('outbound', 'pending')).toBeNull();
    expect(shipmentTemplate('return', 'in_transit')).toBeNull();
  });

  it('etapa del carrito → plantilla', () => {
    expect(cartReminderTemplate('24h')).toBe('cart.reminder.24h');
    expect(cartReminderTemplate('5h')).toBeNull();
  });
});

describe('dedupeKey', () => {
  it('es estable, ignora mayúsculas del destinatario y no expone el email', () => {
    const a = dedupeKey('order.placed', 'o-1', 'email', 'Ana@Example.test');
    expect(a).toBe(dedupeKey('order.placed', 'o-1', 'email', 'ana@example.test'));
    expect(a).not.toContain('ana');
    expect(a.startsWith('order.placed:o-1:email:')).toBe(true);
  });

  it('cambia con el canal, la fuente o el destinatario', () => {
    const base = dedupeKey('order.placed', 'o-1', 'email', 'ana@example.test');
    expect(dedupeKey('order.placed', 'o-1', 'whatsapp', 'ana@example.test')).not.toBe(base);
    expect(dedupeKey('order.placed', 'o-2', 'email', 'ana@example.test')).not.toBe(base);
    expect(dedupeKey('order.placed', 'o-1', 'email', 'luis@example.test')).not.toBe(base);
  });
});

describe('toE164', () => {
  it.each([
    ['0991234567', '+593991234567'],
    ['099 123 4567', '+593991234567'],
    ['022345678', '+59322345678'],
    ['593991234567', '+593991234567'],
    ['+593991234567', '+593991234567'],
    ['+14155550123', '+14155550123'],
  ])('%s → %s', (raw, expected) => {
    expect(toE164(raw)).toBe(expected);
  });

  it.each([null, '', '12345', '0891234567', '+0123'])('%s no es válido', (raw) => {
    expect(toE164(raw)).toBeNull();
  });

  it('WhatsApp y SMS solo a celulares de Ecuador', () => {
    expect(isMobile('+593991234567')).toBe(true);
    expect(isMobile('+59322345678')).toBe(false);
    expect(isMobile('+14155550123')).toBe(true);
  });

  it('normalizeEmail', () => {
    expect(normalizeEmail(' Ana@Example.TEST ')).toBe('ana@example.test');
    expect(normalizeEmail('no-es-email')).toBeNull();
  });
});

describe('localeCandidates', () => {
  it('exacto, mismo idioma soportado y es-EC al final', () => {
    expect(localeCandidates('en-GB')).toEqual(['en-GB', 'en-US', 'es-EC']);
    expect(localeCandidates('en-US')).toEqual(['en-US', 'es-EC']);
    expect(localeCandidates('es-MX')).toEqual(['es-MX', 'es-EC']);
    expect(localeCandidates(null)).toEqual(['es-EC']);
    expect(localeCandidates('basura!')).toEqual(['es-EC']);
  });
});

describe('onFailure (backoff)', () => {
  const policy = { maxAttempts: 4, baseSeconds: 30, maxSeconds: 100 };
  const now = new Date('2026-10-01T12:00:00Z');

  it('transitorio: reintenta con backoff exponencial y tope', () => {
    expect(onFailure(0, false, policy, now)).toEqual({ kind: 'retry', attempts: 1, nextAttemptAt: new Date('2026-10-01T12:00:30Z') });
    expect(onFailure(1, false, policy, now)).toEqual({ kind: 'retry', attempts: 2, nextAttemptAt: new Date('2026-10-01T12:01:00Z') });
    expect(onFailure(2, false, policy, now)).toEqual({ kind: 'retry', attempts: 3, nextAttemptAt: new Date('2026-10-01T12:01:40Z') });
  });

  it('agotados los intentos o error permanente: failed', () => {
    expect(onFailure(3, false, policy, now)).toEqual({ kind: 'failed', attempts: 4 });
    expect(onFailure(0, true, policy, now)).toEqual({ kind: 'failed', attempts: 1 });
  });
});
