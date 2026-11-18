import { createHash } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request, { Response } from 'supertest';
import { Database } from '../../libs/shared-kernel';
import {
  createCustomer,
  createSellableVariant,
  createTenant,
  createWarehouse,
  customerTokenFor,
  PROMOTION_PERMISSIONS,
  setStock,
  TestTenant,
  tokenFor,
} from '../support/fixtures';
import { createTestApp } from '../support/test-app';

/** Valor de la cookie cart_token en Set-Cookie, o undefined. '' si se borró. */
function cartCookie(res: Response): { value: string; raw: string } | undefined {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  const raw = header?.find((c) => c.startsWith('cart_token='));
  if (!raw) return undefined;
  return { value: raw.slice('cart_token='.length).split(';')[0], raw };
}

describe('Carrito (HTTP + PostgreSQL)', () => {
  let app: INestApplication;
  let db: Database;
  let t: TestTenant;
  let staff: string;
  let warehouseId: string;
  let blusa: string; // 20.00, IVA 15 %, mujer/blusas, stock 10
  let bolso: string; // 30.00, IVA 0 %, stock 5
  let jean: string; // 45.00, stock 1
  let borrador: string; // producto en draft
  let agotada: string; // stock 0
  let customerA: string;
  let customerB: string;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    t = await createTenant(db);
    staff = `Bearer ${tokenFor(t, PROMOTION_PERMISSIONS)}`;
    warehouseId = await createWarehouse(db, t.tenantId);
    blusa = (await createSellableVariant(db, t.tenantId, { price: '20.00', categoryPath: 'mujer/blusas', name: 'Blusa lino' })).variantId;
    bolso = (await createSellableVariant(db, t.tenantId, { price: '30.00', taxCode: '0', categoryPath: 'accesorios/bolsos' })).variantId;
    jean = (await createSellableVariant(db, t.tenantId, { price: '45.00', categoryPath: 'hombre/jeans' })).variantId;
    borrador = (await createSellableVariant(db, t.tenantId, { price: '10.00', status: 'draft' })).variantId;
    agotada = (await createSellableVariant(db, t.tenantId, { price: '10.00' })).variantId;
    await setStock(db, blusa, warehouseId, 10);
    await setStock(db, bolso, warehouseId, 5);
    await setStock(db, jean, warehouseId, 1);
    await setStock(db, borrador, warehouseId, 10);
    await setStock(db, agotada, warehouseId, 0);
    customerA = await createCustomer(db, t.tenantId);
    customerB = await createCustomer(db, t.tenantId);
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();
  const asCustomer = (id: string) => `Bearer ${customerTokenFor(t.tenantId, id)}`;
  /** Petición de invitado (header de tenant + cookie opcional). */
  const guest = (method: 'get' | 'post' | 'patch' | 'delete' | 'put', path: string, token?: string) => {
    const req = request(server())[method](`/v1/cart${path}`).set('X-Tenant-Id', t.tenantId);
    return token ? req.set('Cookie', `cart_token=${token}`) : req;
  };

  async function newGuestCart(variantId = blusa, quantity = 1): Promise<string> {
    const res = await guest('post', '/items').send({ variantId, quantity }).expect(200);
    return cartCookie(res)!.value;
  }

  async function createCouponPromotion(code: string, body: Record<string, unknown>) {
    const promo = await request(server())
      .post('/v1/promotions')
      .set('Authorization', staff)
      .send({ name: `Promo ${code}`, requiresCoupon: true, startsAt: '2026-01-01T00:00:00Z', ...body })
      .expect(201);
    await request(server()).post(`/v1/promotions/${promo.body.id}/coupons`).set('Authorization', staff).send({ code }).expect(201);
    return promo.body.id as string;
  }

  describe('invitado con cookie httpOnly', () => {
    it('sin header X-Tenant-Id ni token → 400', async () => {
      await request(server()).get('/v1/cart').expect(400);
    });

    it('GET sin cookie: carrito vacío y no crea nada', async () => {
      const res = await guest('get', '').expect(200);
      expect(res.body).toMatchObject({ id: null, items: [], totals: { total: '0.00' }, canCheckout: false });
      expect(cartCookie(res)).toBeUndefined();
    });

    it('el primer ítem crea el carrito y pone la cookie httpOnly; en la base solo queda el hash', async () => {
      const res = await guest('post', '/items').send({ variantId: blusa, quantity: 2 }).expect(200);
      const cookie = cartCookie(res)!;
      expect(cookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(cookie.raw).toMatch(/HttpOnly/);
      expect(cookie.raw).toMatch(/SameSite=Lax/);
      expect(cookie.raw).toMatch(/Path=\//);
      expect(cookie.raw).toMatch(/Max-Age=2592000/); // 30 días

      // 2 × 20.00 = 40.00; IVA 15 % = 6.00
      expect(res.body).toMatchObject({
        guest: true,
        items: [{ variantId: blusa, quantity: 2, unitPrice: '20.00', taxRate: '15.00', taxAmount: '6.00', total: '46.00', issues: [] }],
        totals: { itemCount: 2, subtotal: '40.00', discountTotal: '0.00', taxTotal: '6.00', total: '46.00' },
        taxes: [{ taxCode: '4', rate: '15.00', base: '40.00', amount: '6.00' }],
        canCheckout: true,
      });

      const { rows } = await db.query(`SELECT user_id, guest_token_hash FROM sales.carts WHERE id = $1`, [res.body.id]);
      expect(rows[0].user_id).toBeNull();
      expect(rows[0].guest_token_hash).toEqual(createHash('sha256').update(cookie.value).digest());
    });

    it('con la cookie se reutiliza el mismo carrito y no se emite otra cookie', async () => {
      const first = await guest('post', '/items').send({ variantId: blusa, quantity: 1 }).expect(200);
      const token = cartCookie(first)!.value;
      const second = await guest('post', '/items', token).send({ variantId: bolso, quantity: 1 }).expect(200);
      expect(second.body.id).toBe(first.body.id);
      expect(cartCookie(second)).toBeUndefined();
      expect(second.body.items).toHaveLength(2);
    });

    it('una cookie desconocida o manipulada no da acceso: GET la borra y un POST crea otro carrito', async () => {
      const token = await newGuestCart();
      const forged = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
      const get = await guest('get', '', forged).expect(200);
      expect(get.body.id).toBeNull();
      expect(cartCookie(get)!.value).toBe('');
      const add = await guest('post', '/items', 'basura').send({ variantId: blusa, quantity: 1 }).expect(200);
      expect(cartCookie(add)!.value).not.toBe(token);
    });

    it('la cookie de un tenant no sirve en otro', async () => {
      const token = await newGuestCart();
      const other = await createTenant(db);
      const res = await request(server()).get('/v1/cart').set('X-Tenant-Id', other.tenantId).set('Cookie', `cart_token=${token}`).expect(200);
      expect(res.body.id).toBeNull();
    });

    it('un carrito de invitado sin actividad por más de 30 días ya no se usa', async () => {
      const token = await newGuestCart();
      await db.query(`UPDATE sales.carts SET last_activity_at = now() - interval '31 days' WHERE guest_token_hash = $1`, [
        createHash('sha256').update(token).digest(),
      ]);
      expect((await guest('get', '', token).expect(200)).body.id).toBeNull();
    });
  });

  describe('validación de stock y disponibilidad', () => {
    it('no deja agregar más que el disponible (contando lo que ya está en el carrito)', async () => {
      const token = await newGuestCart(jean, 1);
      const res = await guest('post', '/items', token).send({ variantId: jean, quantity: 1 }).expect(409);
      expect(res.body.error).toMatchObject({ code: 'INSUFFICIENT_STOCK', details: { variantId: jean, requested: 2, available: 1 } });
    });

    it('agotado → 409; producto no publicado → 409; inexistente → 404; más de 20 → 400', async () => {
      expect((await guest('post', '/items').send({ variantId: agotada, quantity: 1 }).expect(409)).body.error.code).toBe('INSUFFICIENT_STOCK');
      expect((await guest('post', '/items').send({ variantId: borrador, quantity: 1 }).expect(409)).body.error.code).toBe(
        'VARIANT_UNAVAILABLE',
      );
      expect(
        (await guest('post', '/items').send({ variantId: '00000000-0000-4000-8000-000000000000', quantity: 1 }).expect(404)).body.error.code,
      ).toBe('VARIANT_NOT_FOUND');
      await guest('post', '/items').send({ variantId: blusa, quantity: 21 }).expect(400);
    });

    it('un error al agregar el primer ítem no deja carrito ni cookie', async () => {
      const res = await guest('post', '/items').send({ variantId: agotada, quantity: 1 }).expect(409);
      expect(cartCookie(res)).toBeUndefined();
    });

    it('PATCH: subir por encima del stock es 409; bajar siempre se permite', async () => {
      const token = await newGuestCart(bolso, 3);
      expect((await guest('patch', `/items/${bolso}`, token).send({ quantity: 6 }).expect(409)).body.error.details).toMatchObject({
        available: 5,
      });
      await setStock(db, bolso, warehouseId, 1);
      try {
        const res = await guest('patch', `/items/${bolso}`, token).send({ quantity: 2 }).expect(200);
        expect(res.body.items[0]).toMatchObject({ quantity: 2, issues: [{ code: 'INSUFFICIENT_STOCK', available: 1 }] });
        expect(res.body.canCheckout).toBe(false);
      } finally {
        await setStock(db, bolso, warehouseId, 5);
      }
    });

    it('si el stock baja después de agregar, la vista lo marca y bloquea el checkout', async () => {
      const token = await newGuestCart(blusa, 4);
      await setStock(db, blusa, warehouseId, 0);
      try {
        const res = await guest('get', '', token).expect(200);
        expect(res.body.items[0]).toMatchObject({ billable: false, availableQuantity: 0, issues: [{ code: 'OUT_OF_STOCK' }], total: null });
        expect(res.body).toMatchObject({ canCheckout: false, totals: { total: '0.00' } });
      } finally {
        await setStock(db, blusa, warehouseId, 10);
      }
    });

    it('DELETE quita la línea; quitar una que no está es 404', async () => {
      const token = await newGuestCart(blusa, 1);
      expect((await guest('delete', `/items/${blusa}`, token).expect(200)).body.items).toEqual([]);
      expect((await guest('delete', `/items/${blusa}`, token).expect(404)).body.error.code).toBe('CART_ITEM_NOT_FOUND');
    });
  });

  describe('cambio de precio e IVA', () => {
    it('avisa cuando el precio cambió desde que se agregó y cobra el vigente; acknowledge quita el aviso', async () => {
      const v = await createSellableVariant(db, t.tenantId, { price: '10.00' });
      await setStock(db, v.variantId, warehouseId, 10);
      const token = await newGuestCart(v.variantId, 1);
      await db.query(`UPDATE catalog.products SET base_price = 12.50 WHERE id = $1`, [v.productId]);

      const res = await guest('get', '', token).expect(200);
      expect(res.body.hasPriceChanges).toBe(true);
      expect(res.body.items[0]).toMatchObject({
        priceAtAdd: '10.00',
        unitPrice: '12.50',
        issues: [{ code: 'PRICE_CHANGED', direction: 'up', previousPrice: '10.00', currentPrice: '12.50' }],
      });
      expect(res.body.totals).toMatchObject({ subtotal: '12.50', taxTotal: '1.88', total: '14.38' }); // 1.875 → 1.88
      expect(res.body.canCheckout).toBe(true); // el cambio de precio solo avisa

      const ack = await guest('post', '/acknowledge-prices', token).expect(200);
      expect(ack.body).toMatchObject({ hasPriceChanges: false, items: [{ priceAtAdd: '12.50', issues: [] }] });
    });

    it('el precio de la variante tiene prioridad sobre el del producto', async () => {
      const v = await createSellableVariant(db, t.tenantId, { price: '10.00' });
      await setStock(db, v.variantId, warehouseId, 10);
      await db.query(`UPDATE catalog.product_variants SET price = 11.00 WHERE id = $1`, [v.variantId]);
      const token = await newGuestCart(v.variantId, 1);
      expect((await guest('get', '', token).expect(200)).body.items[0]).toMatchObject({ unitPrice: '11.00', priceAtAdd: '11.00' });
    });

    it('mezcla de tarifas: IVA por línea y desglose por código', async () => {
      const token = await newGuestCart(blusa, 1);
      const res = await guest('post', '/items', token).send({ variantId: bolso, quantity: 2 }).expect(200);
      expect(res.body.taxes).toEqual([
        { taxCode: '0', rate: '0.00', base: '60.00', amount: '0.00' },
        { taxCode: '4', rate: '15.00', base: '20.00', amount: '3.00' },
      ]);
      expect(res.body.totals).toMatchObject({ subtotal: '80.00', taxTotal: '3.00', total: '83.00' });
    });
  });

  describe('cupones y promociones en el carrito', () => {
    it('aplica un cupón: el descuento baja la base del IVA', async () => {
      await createCouponPromotion('CARRITO10', { type: 'percent', benefit: { percent: 10 } });
      const token = await newGuestCart(blusa, 2);
      const res = await guest('post', '/coupons', token).send({ code: 'carrito10' }).expect(200);
      // 40.00 − 4.00 = 36.00; IVA 5.40
      expect(res.body.coupons).toEqual([{ code: 'CARRITO10', applied: true, discount: '4.00', reason: null, message: null }]);
      expect(res.body.items[0]).toMatchObject({ discount: '4.00', taxAmount: '5.40', total: '41.40' });
      expect(res.body.totals).toMatchObject({ subtotal: '40.00', discountTotal: '4.00', taxableBase: '36.00', taxTotal: '5.40', total: '41.40' });
    });

    it('rechaza con el motivo del motor y no guarda el cupón', async () => {
      await createCouponPromotion('MIN100', { type: 'fixed', benefit: { amount: '15' }, conditions: { minSubtotal: '100' } });
      const token = await newGuestCart(blusa, 1);
      expect((await guest('post', '/coupons', token).send({ code: 'NOEXISTE' }).expect(422)).body.error.code).toBe('COUPON_NOT_FOUND');
      const res = await guest('post', '/coupons', token).send({ code: 'MIN100' }).expect(422);
      expect(res.body.error).toMatchObject({ code: 'CONDITIONS_NOT_MET', details: { code: 'MIN100', missing: '80.00' } });
      expect((await guest('get', '', token).expect(200)).body.coupons).toEqual([]);
    });

    it('cupones no combinables: el segundo se rechaza con NOT_COMBINABLE', async () => {
      await createCouponPromotion('SOLO15', { type: 'percent', benefit: { percent: 15 } });
      await createCouponPromotion('EXTRA3', { type: 'fixed', benefit: { amount: '3' }, stackable: true });
      const token = await newGuestCart(blusa, 1);
      await guest('post', '/coupons', token).send({ code: 'SOLO15' }).expect(200);
      const res = await guest('post', '/coupons', token).send({ code: 'EXTRA3' }).expect(422);
      expect(res.body.error.code).toBe('NOT_COMBINABLE');
      const cart = await guest('get', '', token).expect(200);
      expect(cart.body.coupons.map((c: { code: string }) => c.code)).toEqual(['SOLO15']);
    });

    it('cupones combinables se suman', async () => {
      await createCouponPromotion('STACK10', { type: 'percent', benefit: { percent: 10 }, stackable: true });
      await createCouponPromotion('STACK2', { type: 'fixed', benefit: { amount: '2' }, stackable: true });
      const token = await newGuestCart(blusa, 1);
      await guest('post', '/coupons', token).send({ code: 'STACK10' }).expect(200);
      const res = await guest('post', '/coupons', token).send({ code: 'STACK2' }).expect(200);
      expect(res.body.totals.discountTotal).toBe('4.00'); // 2.00 + 2.00
    });

    it('un cupón guardado que deja de cumplir condiciones queda visible con su motivo', async () => {
      await createCouponPromotion('DOSBLUSAS', { type: 'fixed', benefit: { amount: '5' }, conditions: { minQuantity: 2 } });
      const token = await newGuestCart(blusa, 2);
      await guest('post', '/coupons', token).send({ code: 'DOSBLUSAS' }).expect(200);
      const res = await guest('patch', `/items/${blusa}`, token).send({ quantity: 1 }).expect(200);
      expect(res.body.coupons).toEqual([
        expect.objectContaining({ code: 'DOSBLUSAS', applied: false, reason: 'CONDITIONS_NOT_MET' }),
      ]);
      expect(res.body.totals.discountTotal).toBe('0.00');
      await guest('delete', '/coupons/dosblusas', token).expect(200);
      await guest('delete', '/coupons/no%20v%C3%A1lido', token).expect(400);
      expect((await guest('get', '', token).expect(200)).body.coupons).toEqual([]);
    });
  });

  describe('carrito de cliente y fusión al iniciar sesión', () => {
    it('un token de staff no usa el carrito', async () => {
      await request(server()).get('/v1/cart').set('Authorization', staff).expect(403);
    });

    it('token inválido → 401 (no degrada a invitado)', async () => {
      await request(server()).get('/v1/cart').set('Authorization', 'Bearer x.y.z').set('X-Tenant-Id', t.tenantId).expect(401);
    });

    it('cada cliente ve solo su carrito; el tenant sale del token', async () => {
      await request(server()).post('/v1/cart/items').set('Authorization', asCustomer(customerA)).send({ variantId: bolso, quantity: 1 }).expect(200);
      const b = await request(server()).get('/v1/cart').set('Authorization', asCustomer(customerB)).expect(200);
      expect(b.body.id).toBeNull();
      const a = await request(server()).get('/v1/cart').set('Authorization', asCustomer(customerA)).expect(200);
      expect(a.body).toMatchObject({ guest: false, items: [{ variantId: bolso, quantity: 1 }] });
    });

    it('GET con token + cookie fusiona: suma cantidades, une cupones y borra la cookie', async () => {
      await createCouponPromotion('FUSION5', { type: 'fixed', benefit: { amount: '5' }, stackable: true });
      const customer = await createCustomer(db, t.tenantId);
      const auth = asCustomer(customer);
      await request(server()).post('/v1/cart/items').set('Authorization', auth).send({ variantId: blusa, quantity: 1 }).expect(200);

      const token = await newGuestCart(blusa, 2);
      await guest('post', '/items', token).send({ variantId: bolso, quantity: 1 }).expect(200);
      await guest('post', '/coupons', token).send({ code: 'FUSION5' }).expect(200);
      const guestCart = await guest('get', '', token).expect(200);

      const res = await request(server()).get('/v1/cart').set('Authorization', auth).set('Cookie', `cart_token=${token}`).expect(200);
      expect(res.body.guest).toBe(false);
      expect(res.body.items.map((i: { variantId: string; quantity: number }) => [i.variantId, i.quantity])).toEqual([
        [blusa, 3],
        [bolso, 1],
      ]);
      expect(res.body.coupons).toEqual([expect.objectContaining({ code: 'FUSION5', applied: true })]);
      const cleared = cartCookie(res)!;
      expect(cleared.value).toBe('');
      expect(cleared.raw).toMatch(/Expires=Thu, 01 Jan 1970/);

      const { rows } = await db.query(`SELECT status FROM sales.carts WHERE id = $1`, [guestCart.body.id]);
      expect(rows[0].status).toBe('merged');

      // Repetir la petición con la cookie vieja no vuelve a sumar.
      const again = await request(server()).get('/v1/cart').set('Authorization', auth).set('Cookie', `cart_token=${token}`).expect(200);
      expect(again.body.items.find((i: { variantId: string }) => i.variantId === blusa).quantity).toBe(3);
    });

    it('POST /cart/merge sin carrito previo: el del invitado pasa a ser del cliente', async () => {
      const customer = await createCustomer(db, t.tenantId);
      const token = await newGuestCart(bolso, 2);
      const res = await request(server())
        .post('/v1/cart/merge')
        .set('Authorization', asCustomer(customer))
        .set('Cookie', `cart_token=${token}`)
        .expect(200);
      expect(res.body).toMatchObject({ guest: false, items: [{ variantId: bolso, quantity: 2 }] });
      await request(server()).post('/v1/cart/merge').set('X-Tenant-Id', t.tenantId).set('Cookie', `cart_token=${token}`).expect(401);
    });

    it('agregados simultáneos del mismo cliente no se pisan (un solo carrito, cantidades sumadas)', async () => {
      const customer = await createCustomer(db, t.tenantId);
      const auth = asCustomer(customer);
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(server()).post('/v1/cart/items').set('Authorization', auth).send({ variantId: blusa, quantity: 1 }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
      const { rows } = await db.query<{ n: number; quantity: number }>(
        `SELECT count(DISTINCT c.id)::int AS n, max(i.quantity) AS quantity
           FROM sales.carts c JOIN sales.cart_items i ON i.cart_id = c.id
          WHERE c.user_id = $1 AND c.status = 'active'`,
        [customer],
      );
      expect(rows[0]).toEqual({ n: 1, quantity: 5 });
    });

    it('el invitado identifica su contacto (email) para límites por cliente y recordatorios', async () => {
      const token = await newGuestCart();
      const res = await guest('put', '/contact', token).send({ email: 'Invitada@Correo.EC' }).expect(200);
      expect(res.body.contactEmail).toBe('invitada@correo.ec');
      await guest('put', '/contact', token).send({ email: 'no-es-email' }).expect(400);
      await guest('put', '/contact', token).send({ email: `${'a'.repeat(250)}@x.ec` }).expect(400);
      await guest('put', '/contact', token).send({ phone: '<script>' }).expect(400);
      await guest('put', '/contact', token).send({ phone: '+593 99 123 4567' }).expect(200);
    });
  });
});
