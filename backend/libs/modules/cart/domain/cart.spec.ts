import { Cart, generateGuestToken, hashGuestToken, isWellFormedGuestToken, MAX_COUPONS, MAX_LINES, MAX_QTY_PER_LINE } from './cart';
import { CartItemNotFoundError, CartLimitError, InvalidContactError } from './errors';

const T0 = new Date('2026-09-29T15:00:00Z');
const T1 = new Date('2026-09-29T16:00:00Z');

describe('token del invitado', () => {
  it('32 bytes base64url; solo se guarda su SHA-256', () => {
    const { token, hash } = generateGuestToken();
    expect(isWellFormedGuestToken(token)).toBe(true);
    expect(hash).toEqual(hashGuestToken(token));
    expect(hash).toHaveLength(32);
    expect(generateGuestToken().token).not.toBe(token);
  });

  it.each([null, undefined, '', 'corto', 'x'.repeat(43) + '!', 'a b'.repeat(15)])('rechaza %p', (value) => {
    expect(isWellFormedGuestToken(value)).toBe(false);
  });
});

describe('Cart · ítems', () => {
  it('agrega, suma a la línea existente y actualiza priceAtAdd al precio actual', () => {
    const cart = Cart.forUser('t', 'u1', T0);
    expect(cart.addItem('v1', 2, '19.9', T0)).toBe(2);
    expect(cart.addItem('v1', 3, '17.50', T1)).toBe(5);
    expect(cart.items).toEqual([{ variantId: 'v1', quantity: 5, priceAtAdd: '17.50', addedAt: T0 }]);
  });

  it(`máximo ${MAX_QTY_PER_LINE} unidades por línea`, () => {
    const cart = Cart.forUser('t', 'u1');
    cart.addItem('v1', 20, '1');
    expect(() => cart.addItem('v1', 1, '1')).toThrow(expect.objectContaining({ code: 'CART_QUANTITY_LIMIT' }));
    expect(() => cart.setQuantity('v1', 21)).toThrow(CartLimitError);
    expect(() => cart.addItem('v2', 0, '1')).toThrow(CartLimitError);
    expect(() => cart.addItem('v2', 1.5, '1')).toThrow(CartLimitError);
  });

  it(`máximo ${MAX_LINES} productos distintos`, () => {
    const cart = Cart.forUser('t', 'u1');
    for (let i = 0; i < MAX_LINES; i++) cart.addItem(`v${i}`, 1, '1');
    expect(() => cart.addItem('otra', 1, '1')).toThrow(expect.objectContaining({ code: 'CART_TOO_MANY_LINES' }));
  });

  it('cambiar cantidad o quitar una línea inexistente es 404', () => {
    const cart = Cart.forUser('t', 'u1');
    expect(() => cart.setQuantity('v1', 1)).toThrow(CartItemNotFoundError);
    expect(() => cart.removeItem('v1')).toThrow(CartItemNotFoundError);
    cart.addItem('v1', 3, '5');
    cart.setQuantity('v1', 1);
    expect(cart.quantityOf('v1')).toBe(1);
    cart.removeItem('v1');
    expect(cart.items).toEqual([]);
  });

  it('acknowledgePrices deja priceAtAdd en el precio vigente', () => {
    const cart = Cart.forUser('t', 'u1');
    cart.addItem('v1', 1, '10');
    cart.addItem('v2', 1, '20');
    cart.acknowledgePrices(new Map([['v1', '12']]));
    expect(cart.items.map((i) => i.priceAtAdd)).toEqual(['12.00', '20.00']);
  });
});

describe('Cart · cupones y contacto', () => {
  it('normaliza y no repite códigos', () => {
    const cart = Cart.forGuest('t', hashGuestToken('x'));
    expect(cart.addCoupon(' bienvenida ')).toBe('BIENVENIDA');
    cart.addCoupon('BIENVENIDA');
    expect(cart.couponCodes).toEqual(['BIENVENIDA']);
    cart.removeCoupon('bienvenida');
    expect(cart.couponCodes).toEqual([]);
  });

  it(`máximo ${MAX_COUPONS} cupones`, () => {
    const cart = Cart.forUser('t', 'u1');
    for (let i = 0; i < MAX_COUPONS; i++) cart.addCoupon(`CUPON${i}`);
    expect(() => cart.addCoupon('OTRO')).toThrow(expect.objectContaining({ code: 'CART_TOO_MANY_COUPONS' }));
  });

  it('contacto normalizado; null borra', () => {
    const cart = Cart.forUser('t', 'u1');
    cart.setContact({ email: ' Ana@Correo.EC ', phone: '+593 99 123 4567' });
    expect(cart.toJSON()).toMatchObject({ contactEmail: 'ana@correo.ec', contactPhone: '+593 99 123 4567' });
    cart.setContact({ email: null });
    expect(cart.toJSON()).toMatchObject({ contactEmail: null, contactPhone: '+593 99 123 4567' });
    expect(() => cart.setContact({ email: 'no-es-email' })).toThrow(InvalidContactError);
  });
});

describe('Cart · fusión al iniciar sesión', () => {
  function carts() {
    const user = Cart.forUser('t', 'u1', T0);
    user.addItem('camisa', 2, '20.00', T1);
    user.addItem('jean', 19, '45.00', T0);
    user.addCoupon('VIP');
    const guest = Cart.forGuest('t', hashGuestToken('tok'), T0);
    guest.addItem('camisa', 3, '18.00', T0); // precio anterior y agregado antes
    guest.addItem('jean', 5, '45.00', T0);
    guest.addItem('medias', 1, '5.00', T0);
    guest.addCoupon('BIENVENIDA');
    guest.addCoupon('vip');
    guest.setContact({ email: 'invitado@correo.ec' });
    return { user, guest };
  }

  it('suma cantidades (con tope), agrega líneas nuevas y conserva el priceAtAdd del usuario', () => {
    const { user, guest } = carts();
    user.absorb(guest, T1);
    expect(user.items).toEqual([
      { variantId: 'camisa', quantity: 5, priceAtAdd: '20.00', addedAt: T0 },
      { variantId: 'jean', quantity: MAX_QTY_PER_LINE, priceAtAdd: '45.00', addedAt: T0 },
      { variantId: 'medias', quantity: 1, priceAtAdd: '5.00', addedAt: T0 },
    ]);
  });

  it('une cupones sin repetir, completa el contacto y marca el carrito del invitado como merged', () => {
    const { user, guest } = carts();
    user.absorb(guest, T1);
    expect(user.couponCodes).toEqual(['VIP', 'BIENVENIDA']);
    expect(user.contactEmail).toBe('invitado@correo.ec');
    expect(guest.status).toBe('merged');
    expect(user.status).toBe('active');
    expect(user.userId).toBe('u1');
  });

  it('no pisa el contacto del usuario', () => {
    const { user, guest } = carts();
    user.setContact({ email: 'cliente@correo.ec' });
    user.absorb(guest);
    expect(user.contactEmail).toBe('cliente@correo.ec');
  });
});
