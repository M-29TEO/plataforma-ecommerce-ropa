import { DeliveryQuoteExpiredError, DeliveryQuoteInvalidError } from './errors';
import { DeliveryOptionClaims, signDeliveryOption, verifyDeliveryOption } from './quote-token';

const now = new Date('2026-09-29T15:00:00Z');
const claims: DeliveryOptionClaims = {
  v: 1,
  tid: 't1',
  typ: 'rider',
  zid: 'z1',
  wid: 'w1',
  cq: null,
  csid: null,
  p: 411,
  cost: null,
  dm: 4530,
  ds: 'osrm',
  eta: null,
  lat: -0.1835,
  lng: -78.4855,
  w: 600,
  vol: 0,
  mt: 4600,
  exp: Math.floor(now.getTime() / 1000) + 900,
};

describe('opción de envío firmada', () => {
  it('verifica lo que se firmó', () => {
    expect(verifyDeliveryOption('s', signDeliveryOption('s', claims), now)).toEqual(claims);
  });

  it('rechaza otra clave, un precio adulterado y basura', () => {
    const token = signDeliveryOption('s', claims);
    expect(() => verifyDeliveryOption('otra', token, now)).toThrow(DeliveryQuoteInvalidError);
    const [, sig] = token.split('.');
    const forged = `${Buffer.from(JSON.stringify({ ...claims, p: 1 })).toString('base64url')}.${sig}`;
    expect(() => verifyDeliveryOption('s', forged, now)).toThrow(DeliveryQuoteInvalidError);
    expect(() => verifyDeliveryOption('s', 'abc', now)).toThrow(DeliveryQuoteInvalidError);
  });

  it('vencida → 409 DELIVERY_QUOTE_EXPIRED', () => {
    const token = signDeliveryOption('s', claims);
    expect(() => verifyDeliveryOption('s', token, new Date((claims.exp + 1) * 1000))).toThrow(DeliveryQuoteExpiredError);
  });
});
