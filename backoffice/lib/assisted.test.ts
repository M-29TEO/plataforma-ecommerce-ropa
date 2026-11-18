import { describe, expect, it } from 'vitest';
import {
  addToCart,
  buildCreateBody,
  canUploadVoucher,
  voucherFileError,
  buildQuoteBody,
  effectiveSelection,
  emptyDraft,
  idNumberError,
  isValidCedula,
  isValidRuc,
  MAX_LINES,
  moneyString,
  normalizePhone,
  optionKey,
  parseDraft,
  paymentMessage,
  resolveSelection,
  setLineQuantity,
  whatsappUrl,
  type AssistedCustomer,
  type AssistedDraft,
  type AssistedOrderResult,
  type AssistedQuote,
  type QuoteOption,
} from './assisted';
import type { VariantLookupItem } from './scanner';

const V1 = '11111111-1111-4111-8111-111111111111';
const V2 = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const ADDR = '44444444-4444-4444-8444-444444444444';
const WH = '55555555-5555-4555-8555-555555555555';
const SLOT = '66666666-6666-4666-8666-666666666666';

function variant(id: string, price = '20.00'): VariantLookupItem {
  return { variantId: id, productId: 'p', sku: `SKU-${id.slice(0, 4)}`, barcode: null, productName: 'Camisa', color: 'Azul', size: 'M', price, status: 'active' };
}

const customer: AssistedCustomer = {
  userId: USER,
  email: 'ana@example.com',
  firstName: 'Ana',
  lastName: 'Pérez',
  phone: '0991234567',
  idType: null,
  idNumber: null,
  status: 'active',
  addresses: [
    {
      addressId: ADDR,
      label: 'Casa',
      isDefault: true,
      recipientName: 'Ana',
      recipientPhone: '0991234567',
      mainStreet: 'Av. Amazonas',
      secondaryStreet: 'Naciones Unidas',
      number: 'N34',
      reference: null,
      neighborhood: 'Iñaquito',
      city: 'Quito',
      province: 'Pichincha',
      lat: -0.17,
      lng: -78.48,
    },
  ],
};

function draft(patch: Partial<AssistedDraft> = {}): AssistedDraft {
  return { ...emptyDraft(), customer, cart: [{ variantId: V1, sku: 'S', productName: 'Camisa', color: null, size: null, price: '20.00', quantity: 2 }], ...patch };
}

const totals = { subtotal: '40.00', discountTotal: '0.00', shippingTotal: '2.50', taxTotal: '5.22', total: '47.72' };

function option(patch: Partial<QuoteOption> = {}): QuoteOption {
  return { quoteId: 'token-rider-xxxxxxxxxxxxxxxxxx', type: 'rider', price: '2.50', label: 'Motorizado', shippingTotal: '2.50', total: '47.72', ...patch };
}

function quote(patch: Partial<AssistedQuote> = {}): AssistedQuote {
  return {
    canPlace: true,
    issues: [],
    items: [],
    coupons: [],
    promotions: [],
    totals,
    delivery: {
      fulfillmentType: 'rider',
      reason: null,
      zone: null,
      parcel: { weightG: 500, volumeCm3: 1000, chargeableKg: 1 },
      validUntil: '2026-10-08T00:00:00Z',
      options: [
        option({
          slots: [
            { slotId: SLOT, startsAt: '2026-10-08T15:00:00Z', price: '3.50', shippingTotal: '3.50', total: '48.72' },
          ],
        }),
        option({ quoteId: 'token-courier-xxxxxxxxxxxxxxxx', type: 'courier', label: 'Servientrega', courier: { code: 'srv', name: 'Servientrega' }, price: '5.00', shippingTotal: '5.00', total: '50.22' }),
      ],
    },
    ...patch,
  };
}

describe('cédula y RUC', () => {
  it('valida la cédula con módulo 10', () => {
    expect(isValidCedula('1710034065')).toBe(true);
    expect(isValidCedula('1710034066')).toBe(false);
    expect(isValidCedula('2510034065')).toBe(false); // provincia 25
    expect(isValidCedula('1760034065')).toBe(false); // tercer dígito ≥ 6
    expect(isValidCedula('171003406')).toBe(false);
    expect(isValidCedula('17100340AB')).toBe(false);
  });

  it('valida el RUC de persona natural, sociedad privada y entidad pública', () => {
    expect(isValidRuc('1710034065001')).toBe(true);
    expect(isValidRuc('1710034065000')).toBe(false);
    expect(isValidRuc('1790011674001')).toBe(true);
    expect(isValidRuc('1790011675001')).toBe(false);
    expect(isValidRuc('1760001550001')).toBe(true);
    expect(isValidRuc('1760001560001')).toBe(false);
    expect(isValidRuc('1770001550001')).toBe(false); // tercer dígito 7
  });

  it('da el mensaje según el tipo', () => {
    expect(idNumberError('05', '1710034065')).toBeNull();
    expect(idNumberError('05', '1710034066')).toMatch(/cédula/);
    expect(idNumberError('04', '1710034065')).toMatch(/RUC/);
    expect(idNumberError('06', 'AB1234')).toBeNull();
    expect(idNumberError('06', 'AB')).toMatch(/pasaporte/);
  });
});

describe('teléfono', () => {
  it('normaliza a E.164 de Ecuador', () => {
    expect(normalizePhone('099 123 4567')).toBe('+593991234567');
    expect(normalizePhone('02-234-5678')).toBe('+59322345678');
    expect(normalizePhone('593991234567')).toBe('+593991234567');
    expect(normalizePhone('+593 99 123 4567')).toBe('+593991234567');
    expect(normalizePhone('+14155552671')).toBe('+14155552671');
  });

  it('rechaza números inválidos', () => {
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('0812345678')).toBeNull();
    expect(normalizePhone('abc')).toBeNull();
    expect(normalizePhone('')).toBeNull();
  });
});

describe('carrito local', () => {
  it('suma a la línea existente y respeta 20 unidades', () => {
    let r = addToCart([], variant(V1));
    expect(r.cart).toHaveLength(1);
    r = addToCart(r.cart, variant(V1));
    expect(r.cart[0].quantity).toBe(2);
    const full = setLineQuantity(r.cart, V1, 99);
    expect(full[0].quantity).toBe(20);
    expect(addToCart(full, variant(V1)).error).toMatch(/20/);
  });

  it('limita a 50 líneas y quita con cantidad 0', () => {
    const cart = Array.from({ length: MAX_LINES }, (_, i) => ({ variantId: `v${i}`, sku: '', productName: '', color: null, size: null, price: '1', quantity: 1 }));
    expect(addToCart(cart, variant(V2)).error).toMatch(/50/);
    expect(setLineQuantity(cart, 'v0', 0)).toHaveLength(MAX_LINES - 1);
  });
});

describe('cuerpo de la cotización', () => {
  it('sin prendas no cotiza', () => {
    expect(buildQuoteBody(draft({ cart: [] }))).toBeNull();
  });

  it('usa la dirección guardada con ubicación por addressId y manda el cliente', () => {
    const r = buildQuoteBody(draft({ addressMode: 'saved', addressId: ADDR, couponCode: ' promo10 ' }));
    expect(r?.provisional).toBe(false);
    expect(r?.body).toEqual({
      items: [{ variantId: V1, quantity: 2 }],
      couponCode: 'PROMO10',
      customer: { userId: USER },
      fulfillment: { type: 'rider', addressId: ADDR },
    });
  });

  it('una dirección guardada sin ubicación se copia con el pin', () => {
    const noPin = { ...customer, addresses: [{ ...customer.addresses[0], lat: null, lng: null }] };
    expect(buildQuoteBody(draft({ customer: noPin, addressMode: 'saved', addressId: ADDR }))).toBeNull();
    const r = buildQuoteBody(draft({ customer: noPin, addressMode: 'saved', addressId: ADDR, pin: { lat: -0.2, lng: -78.5 } }));
    expect(r?.body.fulfillment).toMatchObject({ type: 'rider', location: { lat: -0.2, lng: -78.5 }, address: { mainStreet: 'Av. Amazonas', city: 'Quito', province: 'Pichincha' } });
    expect(r?.body.fulfillment.addressId).toBeUndefined();
  });

  it('dirección nueva exige pin; sin entrega completa cotiza como retiro provisional', () => {
    const d = draft({ address: { ...emptyDraft().address, mainStreet: 'Calle 1' } });
    expect(buildQuoteBody(d)).toBeNull();
    const r = buildQuoteBody(d, WH);
    expect(r).toMatchObject({ provisional: true, body: { fulfillment: { type: 'pickup', pickupWarehouseId: WH } } });
    const withPin = buildQuoteBody({ ...d, pin: { lat: 1, lng: 2 } });
    expect(withPin?.body.fulfillment).toEqual({ type: 'rider', address: { mainStreet: 'Calle 1', city: 'Quito', province: 'Pichincha' }, location: { lat: 1, lng: 2 } });
  });

  it('invitado: solo se manda si es válido y con el teléfono en E.164', () => {
    const guest = { email: 'Luis@Example.com ', firstName: 'Luis', lastName: 'Mora', phone: '0987654321', idType: '05' as const, idNumber: '1710034065' };
    const base = { customerMode: 'guest' as const, fulfillmentType: 'pickup' as const, pickupWarehouseId: WH };
    expect(buildQuoteBody(draft({ ...base, guest: { ...guest, phone: '12' } }))?.body.customer).toBeUndefined();
    expect(buildQuoteBody(draft({ ...base, guest }))?.body.customer).toEqual({
      guest: { email: 'luis@example.com', firstName: 'Luis', lastName: 'Mora', phone: '+593987654321', idType: '05', idNumber: '1710034065' },
    });
  });

  it('un cliente bloqueado no se manda', () => {
    expect(buildQuoteBody(draft({ customer: { ...customer, status: 'blocked' }, fulfillmentType: 'pickup', pickupWarehouseId: WH }))?.body.customer).toBeUndefined();
  });
});

describe('opción elegida', () => {
  it('usa el total de la franja o de la opción', () => {
    const q = quote();
    const [rider, courier] = q.delivery!.options;
    expect(resolveSelection(q, { fulfillmentType: 'rider', optionKey: null, slotId: null }).missing).toMatch(/opción/);
    expect(resolveSelection(q, { fulfillmentType: 'rider', optionKey: optionKey(rider), slotId: null }).missing).toMatch(/franja/);
    expect(resolveSelection(q, { fulfillmentType: 'rider', optionKey: optionKey(rider), slotId: SLOT }).totals.total).toBe('48.72');
    const c = resolveSelection(q, { fulfillmentType: 'rider', optionKey: optionKey(courier), slotId: null });
    expect(c.totals).toMatchObject({ shippingTotal: '5.00', total: '50.22', subtotal: '40.00' });
  });

  it('la selección efectiva cae en la primera opción y franja si la elegida ya no está', () => {
    const q = quote();
    expect(effectiveSelection(q, { optionKey: 'otra', slotId: null })).toEqual({ optionKey: optionKey(q.delivery!.options[0]), slotId: SLOT });
    const courierKey = optionKey(q.delivery!.options[1]);
    expect(effectiveSelection(q, { optionKey: courierKey, slotId: SLOT })).toEqual({ optionKey: courierKey, slotId: null });
    expect(effectiveSelection(undefined, { optionKey: 'x', slotId: null })).toEqual({ optionKey: 'x', slotId: null });
  });

  it('retiro usa los totales de la cotización', () => {
    expect(resolveSelection(quote({ delivery: null }), { fulfillmentType: 'pickup', optionKey: null, slotId: null })).toMatchObject({ missing: null, totals });
  });
});

describe('cuerpo de creación', () => {
  it('manda token, franja, total esperado y facturación', () => {
    const q = quote();
    const d = draft({
      addressMode: 'saved',
      addressId: ADDR,
      optionKey: optionKey(q.delivery!.options[0]),
      slotId: SLOT,
      paymentMethod: 'card_link',
      billingMode: 'id',
      billing: { name: 'Ana Pérez', idType: '04', idNumber: '1790011674001', email: '', address: '' },
      notes: '  Tocar el timbre ',
    });
    const r = buildCreateBody(d, q);
    expect('body' in r && r.body).toEqual({
      customer: { userId: USER },
      items: [{ variantId: V1, quantity: 2 }],
      fulfillment: { type: 'rider', addressId: ADDR, quoteToken: 'token-rider-xxxxxxxxxxxxxxxxxx', slotId: SLOT },
      paymentMethod: 'card_link',
      expectedTotal: '48.72',
      billing: { name: 'Ana Pérez', idType: '04', idNumber: '1790011674001' },
      notes: 'Tocar el timbre',
    });
  });

  it('el tipo de entrega es el de la opción (courier ofrecido en lugar de motorizado)', () => {
    const q = quote();
    const r = buildCreateBody(draft({ addressMode: 'saved', addressId: ADDR, optionKey: optionKey(q.delivery!.options[1]) }), q);
    expect('body' in r && r.body.fulfillment).toMatchObject({ type: 'courier', quoteToken: 'token-courier-xxxxxxxxxxxxxxxx' });
    expect('body' in r && r.body.expectedTotal).toBe('50.22');
  });

  it('retiro sin token y consumidor final sin billing', () => {
    const r = buildCreateBody(draft({ fulfillmentType: 'pickup', pickupWarehouseId: WH, paymentMethod: 'cod' }), quote({ delivery: null }));
    expect('body' in r && r.body).toEqual({
      customer: { userId: USER },
      items: [{ variantId: V1, quantity: 2 }],
      fulfillment: { type: 'pickup', pickupWarehouseId: WH },
      paymentMethod: 'cod',
      expectedTotal: '47.72',
    });
  });

  it('bloquea con stock insuficiente, sin cliente o con factura inválida', () => {
    const base = { fulfillmentType: 'pickup' as const, pickupWarehouseId: WH };
    expect(buildCreateBody(draft(base), quote({ canPlace: false, delivery: null }))).toMatchObject({ error: expect.stringMatching(/stock/) });
    expect(buildCreateBody(draft({ ...base, customer: null }), quote({ delivery: null }))).toMatchObject({ error: expect.stringMatching(/cliente/) });
    expect(
      buildCreateBody(draft({ ...base, billingMode: 'id', billing: { name: 'X Y', idType: '05', idNumber: '123', email: '', address: '' } }), quote({ delivery: null })),
    ).toMatchObject({ error: expect.stringMatching(/facturación/) });
  });
});

describe('mensajes y borrador', () => {
  const result: AssistedOrderResult = {
    orderId: 'o1',
    orderNumber: 'MO-000123',
    status: 'created',
    paymentStatus: 'pending',
    channel: 'backoffice',
    sellerId: 's1',
    total: '48.72',
    totals: {},
    delivery: null,
    payment: { id: 'p1', method: 'card_link', status: 'pending', amount: '48.72', expiresAt: '2026-10-09T00:00:00Z', clientSecret: 'x', paymentUrl: 'https://pay.local/p1' },
  };
  const fmt = { money: (v: string) => `$${v}`, dateTime: (v: string) => `F(${v})` };

  it('mensaje de enlace de pago y de transferencia', () => {
    const m = paymentMessage(result, { ...fmt, name: 'Ana', trackingUrl: 'https://tienda/seguimiento/t' });
    expect(m).toContain('Hola Ana, tu pedido MO-000123 por $48.72');
    expect(m).toContain('https://pay.local/p1');
    expect(m).toContain('vence el F(2026-10-09T00:00:00Z)');
    expect(m).toContain('https://tienda/seguimiento/t');
    const t = paymentMessage(
      { ...result, payment: { ...result.payment, method: 'transfer', paymentUrl: undefined, transfer: { account: 'Banco 123', reference: 'REF9', expiresAt: null, voucherUploadPath: '/v1/x' } } },
      fmt,
    );
    expect(t).toContain('Cuenta: Banco 123');
    expect(t).toContain('Referencia: REF9');
  });

  it('enlace de WhatsApp sin "+" y con texto codificado', () => {
    expect(whatsappUrl('+593991234567', 'Hola ñ')).toBe('https://wa.me/593991234567?text=Hola%20%C3%B1');
    expect(whatsappUrl(null, 'a')).toBe('https://wa.me/?text=a');
  });

  it('valida el comprobante y cuándo se puede subir', () => {
    expect(voucherFileError(null)).toMatch(/Elige/);
    expect(voucherFileError({ type: 'image/gif', size: 10 })).toMatch(/JPG/);
    expect(voucherFileError({ type: 'application/pdf', size: 6 * 1024 * 1024 })).toMatch(/5 MB/);
    expect(voucherFileError({ type: 'image/png', size: 1000 })).toBeNull();
    expect(canUploadVoucher({ paymentMethod: 'transfer', paymentStatus: 'pending', status: 'created' })).toBe(true);
    expect(canUploadVoucher({ paymentMethod: 'transfer', paymentStatus: 'paid', status: 'paid' })).toBe(false);
    expect(canUploadVoucher({ paymentMethod: 'cod', paymentStatus: 'pending', status: 'created' })).toBe(false);
  });

  it('moneyString y borrador guardado', () => {
    expect(moneyString('49')).toBe('49.00');
    expect(moneyString(49.5)).toBe('49.50');
    expect(parseDraft(null)).toBeNull();
    expect(parseDraft('{roto')).toBeNull();
    expect(parseDraft('{"x":1}')).toBeNull();
    const d = parseDraft(JSON.stringify({ cart: [], step: 9, guest: { email: 'a@b.co' } }));
    expect(d?.step).toBe(4);
    expect(d?.guest).toMatchObject({ email: 'a@b.co', firstName: '' });
  });
});
