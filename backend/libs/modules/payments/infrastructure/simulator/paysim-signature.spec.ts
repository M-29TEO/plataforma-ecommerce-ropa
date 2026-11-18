import { canonicalParams, hmacHex, signParams, signWebhook, verifyWebhookSignature } from './paysim-signature';

const SECRET = 'secreto';
const BODY = Buffer.from('{"id":"evt_1","type":"payment.approved"}');
const NOW = 1_790_000_000;

describe('firma de la pasarela simulada', () => {
  it('acepta la firma correcta dentro de la tolerancia', () => {
    const header = signWebhook(SECRET, BODY, NOW - 10);
    expect(verifyWebhookSignature(SECRET, BODY, header, 300, NOW)).toBe(true);
  });

  it('rechaza cuerpo alterado, otro secreto, header ausente o mal formado', () => {
    const header = signWebhook(SECRET, BODY, NOW);
    expect(verifyWebhookSignature(SECRET, Buffer.from(BODY.toString().replace('approved', 'rejected')), header, 300, NOW)).toBe(false);
    expect(verifyWebhookSignature('otro', BODY, header, 300, NOW)).toBe(false);
    expect(verifyWebhookSignature(SECRET, BODY, undefined, 300, NOW)).toBe(false);
    expect(verifyWebhookSignature(SECRET, BODY, 'v1=abc', 300, NOW)).toBe(false);
    expect(verifyWebhookSignature(SECRET, BODY, `t=${NOW},v1=zz`, 300, NOW)).toBe(false);
  });

  it('rechaza una firma vieja (replay) aunque sea auténtica', () => {
    const header = signWebhook(SECRET, BODY, NOW - 301);
    expect(verifyWebhookSignature(SECRET, BODY, header, 300, NOW)).toBe(false);
  });

  it('la marca de tiempo es parte de lo firmado: cambiarla invalida la firma', () => {
    const [, v1] = signWebhook(SECRET, BODY, NOW).split(',');
    expect(verifyWebhookSignature(SECRET, BODY, `t=${NOW - 1},${v1}`, 300, NOW)).toBe(false);
  });

  it('los parámetros del pedido de pago se firman en orden canónico', () => {
    expect(canonicalParams({ ref: 'a b', amount: '1.00' })).toBe('amount=1.00&ref=a%20b');
    expect(signParams(SECRET, { ref: 'x', amount: '1.00' })).toBe(hmacHex(SECRET, 'amount=1.00&ref=x'));
  });
});
