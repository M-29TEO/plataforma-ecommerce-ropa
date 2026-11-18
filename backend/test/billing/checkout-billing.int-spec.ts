import { INestApplication } from '@nestjs/common';
import { Database } from '../../libs/shared-kernel';
import { countRows, createShop, deliveryBody, guestCart, postCheckout, reservations, Shop } from '../support/shop';
import { createTestApp } from '../support/test-app';

/**
 * Checkout valida al comprador antes de vender (BillingApi): la factura no debe terminar DEVUELTA.
 * Blusa 20.00 + IVA 15 % y envío por motorizado 3.00: 1 blusa = 26.00, 3 blusas = 72.00.
 */
describe('Checkout: datos de facturación', () => {
  let app: INestApplication;
  let db: Database;
  let shop: Shop;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    shop = await createShop(db, { blusa: 50 });
  });

  afterAll(async () => {
    await app.close();
  });

  const guest = { name: 'Ana Pérez', email: 'ana@example.test' };

  it('consumidor final hasta USD 50: se vende sin identificación', async () => {
    const cookie = await guestCart(app, shop.tenantId, [{ variantId: shop.blusa, quantity: 1 }]);
    const res = await postCheckout(app, shop.tenantId, { cookie }, await deliveryBody(app, shop.tenantId, { cookie }, { customer: guest }));
    expect(res.status).toBe(201);
    expect(res.body.totals.total).toBe('26.00');
  });

  it('más de USD 50 sin identificación: 422 BILLING_ID_REQUIRED y no reserva nada', async () => {
    const cookie = await guestCart(app, shop.tenantId, [{ variantId: shop.blusa, quantity: 3 }]);
    const before = await countRows(db, `SELECT count(*) AS n FROM sales.orders WHERE tenant_id = $1`, [shop.tenantId]);
    const res = await postCheckout(app, shop.tenantId, { cookie }, await deliveryBody(app, shop.tenantId, { cookie }, { customer: guest }));
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'BILLING_ID_REQUIRED', details: { total: '72.00', limit: '50.00' } });
    expect(await countRows(db, `SELECT count(*) AS n FROM sales.orders WHERE tenant_id = $1`, [shop.tenantId])).toBe(before);

    // Con la cédula en los datos de facturación, la misma compra pasa.
    const ok = await postCheckout(
      app,
      shop.tenantId,
      { cookie },
      await deliveryBody(app, shop.tenantId, { cookie }, { customer: guest, billing: { name: 'Ana Pérez', idType: '05', idNumber: '1710034065' } }),
    );
    expect(ok.status).toBe(201);
    expect(await reservations(db, ok.body.orderId)).toHaveLength(1);
  });

  it('cédula inválida: 422 INVALID_BUYER_ID', async () => {
    const cookie = await guestCart(app, shop.tenantId, [{ variantId: shop.blusa, quantity: 1 }]);
    const res = await postCheckout(
      app,
      shop.tenantId,
      { cookie },
      await deliveryBody(app, shop.tenantId, { cookie }, { customer: { ...guest, idType: '05', idNumber: '1712345678' } }),
    );
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_BUYER_ID');
  });

  it('identificación con formato que no corresponde a su tipo o email demasiado largo: 400 antes de cotizar nada', async () => {
    const cookie = await guestCart(app, shop.tenantId, [{ variantId: shop.blusa, quantity: 1 }]);
    const send = async (billing: Record<string, unknown>) =>
      postCheckout(app, shop.tenantId, { cookie }, await deliveryBody(app, shop.tenantId, { cookie }, { customer: guest, billing }));
    const ana = { name: 'Ana Pérez', idType: '05', idNumber: '1710034065' };
    expect((await send({ ...ana, idType: '04' })).status).toBe(400); // RUC de 10 dígitos
    expect((await send({ ...ana, idNumber: '171003406X' })).status).toBe(400); // cédula con letra
    expect((await send({ ...ana, idType: '06', idNumber: 'AB-12' })).status).toBe(400); // pasaporte con guion
    expect((await send({ ...ana, email: `${'a'.repeat(250)}@example.test` })).status).toBe(400);
    expect((await send({ ...ana, idType: '06', idNumber: 'A1234567' })).status).toBe(201);
  });
});
