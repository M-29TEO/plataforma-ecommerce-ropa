import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PricingLineInput, PromotionsApi } from '../../libs/modules/promotions';
import { Database } from '../../libs/shared-kernel';
import { createCustomer, createTenant, PROMOTION_PERMISSIONS, TestTenant, tokenFor } from '../support/fixtures';
import { createTestApp } from '../support/test-app';

const LINES: PricingLineInput[] = [
  { lineId: 'v1', variantId: 'v1', productId: 'p1', categoryPath: 'mujer/blusas', brandId: null, quantity: 2, unitPrice: '25.00' },
];

describe('Promociones, cupones y gift cards (HTTP + PostgreSQL)', () => {
  let app: INestApplication;
  let db: Database;
  let promotions: PromotionsApi;
  let t: TestTenant;
  let staff: string;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    promotions = app.get(PromotionsApi);
    t = await createTenant(db);
    staff = `Bearer ${tokenFor(t, PROMOTION_PERMISSIONS)}`;
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();

  async function createPromotion(body: Record<string, unknown>) {
    const res = await request(server())
      .post('/v1/promotions')
      .set('Authorization', staff)
      .send({ name: 'Promo', startsAt: '2026-01-01T00:00:00Z', ...body })
      .expect(201);
    return res.body as { id: string };
  }

  async function createCoupon(promotionId: string, body: Record<string, unknown>) {
    const res = await request(server()).post(`/v1/promotions/${promotionId}/coupons`).set('Authorization', staff).send(body).expect(201);
    return res.body as { id: string; code: string };
  }

  async function counters(promotionId: string, couponId?: string) {
    const p = await db.query<{ used_count: number }>(`SELECT used_count FROM sales.promotions WHERE id = $1`, [promotionId]);
    const c = couponId ? await db.query<{ used_count: number }>(`SELECT used_count FROM sales.coupons WHERE id = $1`, [couponId]) : null;
    const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM sales.promotion_redemptions WHERE promotion_id = $1`, [promotionId]);
    return { promotion: p.rows[0].used_count, coupon: c?.rows[0].used_count ?? null, redemptions: r.rows[0].n };
  }

  const redeem = (promotionId: string, couponId: string | null, who: { userId?: string | null; email?: string | null }, orderId = randomUUID()) =>
    promotions.redeem({
      tenantId: t.tenantId,
      orderId,
      userId: who.userId ?? null,
      email: who.email ?? null,
      promotions: [{ promotionId, couponId, discount: '5.00' }],
    });

  describe('administración (backoffice)', () => {
    it('crea, lista, consulta con cupones y desactiva', async () => {
      const promo = await createPromotion({
        name: '2x1 en blusas',
        type: 'buy_x_get_y',
        conditions: { categoryPaths: ['Mujer/Blusas'] },
        benefit: { buyQuantity: 1, getQuantity: 1 },
        requiresCoupon: true,
        maxUses: 500,
      });
      expect(promo).toMatchObject({
        type: 'buy_x_get_y',
        conditions: { categoryPaths: ['mujer/blusas'] },
        benefit: { buyQuantity: 1, getQuantity: 1, percentOff: 100 },
        stackable: false,
        priority: 100,
        usedCount: 0,
      });
      await createCoupon(promo.id, { code: 'blusas2x1', maxUses: 100, maxUsesPerCustomer: 2 });

      const detail = await request(server()).get(`/v1/promotions/${promo.id}`).set('Authorization', staff).expect(200);
      expect(detail.body.coupons).toEqual([
        expect.objectContaining({ code: 'BLUSAS2X1', maxUses: 100, maxUsesPerCustomer: 2, usedCount: 0 }),
      ]);

      const patched = await request(server())
        .patch(`/v1/promotions/${promo.id}`)
        .set('Authorization', staff)
        .send({ active: false, benefit: { buyQuantity: 2, getQuantity: 1 } })
        .expect(200);
      expect(patched.body).toMatchObject({ active: false, benefit: { buyQuantity: 2, getQuantity: 1, percentOff: 100 } });

      const list = await request(server()).get('/v1/promotions?active=false&type=buy_x_get_y').set('Authorization', staff).expect(200);
      expect(list.body.map((p: { id: string }) => p.id)).toContain(promo.id);
    });

    it('valida la definición según el tipo (422) y el DTO (400)', async () => {
      const bad = await request(server())
        .post('/v1/promotions')
        .set('Authorization', staff)
        .send({ name: 'X', type: 'percent', benefit: { percent: 120 }, startsAt: '2026-01-01T00:00:00Z' })
        .expect(422);
      expect(bad.body.error).toMatchObject({ code: 'INVALID_PROMOTION', details: { field: 'benefit.percent' } });
      await request(server())
        .post('/v1/promotions')
        .set('Authorization', staff)
        .send({ name: 'X', type: 'gift', benefit: {}, startsAt: '2026-01-01T00:00:00Z' })
        .expect(400);
      await request(server())
        .post('/v1/promotions')
        .set('Authorization', staff)
        .send({ name: 'X', type: 'fixed', benefit: { amount: '5' }, startsAt: '2026-02-01T00:00:00Z', endsAt: '2026-01-01T00:00:00Z' })
        .expect(422);
    });

    it('código de cupón único por tenant sin distinguir mayúsculas → 409', async () => {
      const promo = await createPromotion({ type: 'fixed', benefit: { amount: '5' }, requiresCoupon: true });
      await createCoupon(promo.id, { code: 'UNICO' });
      const res = await request(server()).post(`/v1/promotions/${promo.id}/coupons`).set('Authorization', staff).send({ code: 'unico' }).expect(409);
      expect(res.body.error.code).toBe('COUPON_CODE_TAKEN');
    });

    it('sin promotions.write → 403', async () => {
      await request(server())
        .post('/v1/promotions')
        .set('Authorization', `Bearer ${tokenFor(t, ['promotions.read'])}`)
        .send({ name: 'X', type: 'fixed', benefit: { amount: '5' }, startsAt: '2026-01-01T00:00:00Z' })
        .expect(403);
    });
  });

  describe('límites de uso (canje atómico en checkout)', () => {
    it('límite global del cupón: 10 checkouts simultáneos por los 3 últimos usos → exactamente 3', async () => {
      const promo = await createPromotion({ type: 'fixed', benefit: { amount: '5' }, requiresCoupon: true });
      const coupon = await createCoupon(promo.id, { code: 'SOLO3', maxUses: 3 });

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) => redeem(promo.id, coupon.id, { email: `cliente${i}@correo.ec` })),
      );
      const ok = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(ok).toHaveLength(3);
      expect(rejected).toHaveLength(7);
      for (const r of rejected) expect(r.reason).toMatchObject({ code: 'COUPON_USAGE_LIMIT' });
      expect(await counters(promo.id, coupon.id)).toEqual({ promotion: 3, coupon: 3, redemptions: 3 });

      const view = await promotions.evaluate({ tenantId: t.tenantId, userId: null, email: 'otro@correo.ec', couponCodes: ['SOLO3'], lines: LINES });
      expect(view.rejectedCoupons).toEqual([expect.objectContaining({ code: 'SOLO3', reason: 'COUPON_USAGE_LIMIT' })]);
    });

    it('límite global de una promoción automática (max_uses) bajo concurrencia', async () => {
      const promo = await createPromotion({ type: 'percent', benefit: { percent: 5 }, maxUses: 2 });
      const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => redeem(promo.id, null, { email: `auto${i}@correo.ec` })));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
      expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.code)).toEqual([
        'PROMOTION_USAGE_LIMIT',
        'PROMOTION_USAGE_LIMIT',
        'PROMOTION_USAGE_LIMIT',
      ]);
      expect((await counters(promo.id)).promotion).toBe(2);

      // Agotada: deja de aparecer como automática.
      const view = await promotions.evaluate({ tenantId: t.tenantId, userId: null, email: null, couponCodes: [], lines: LINES });
      expect(view.applied.map((a) => a.promotionId)).not.toContain(promo.id);
    });

    it('límite por cliente: el mismo cliente en 5 checkouts simultáneos solo canjea 1 vez', async () => {
      const promo = await createPromotion({ type: 'fixed', benefit: { amount: '5' }, requiresCoupon: true });
      const coupon = await createCoupon(promo.id, { code: 'BIENVENIDA' });
      const customer = await createCustomer(db, t.tenantId);

      const results = await Promise.allSettled(Array.from({ length: 5 }, () => redeem(promo.id, coupon.id, { userId: customer })));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results.filter((x): x is PromiseRejectedResult => x.status === 'rejected')) {
        expect(r.reason).toMatchObject({ code: 'COUPON_CUSTOMER_LIMIT' });
      }
      expect(await counters(promo.id, coupon.id)).toEqual({ promotion: 1, coupon: 1, redemptions: 1 });

      const view = await promotions.evaluate({ tenantId: t.tenantId, userId: customer, email: null, couponCodes: ['bienvenida'], lines: LINES });
      expect(view.rejectedCoupons).toEqual([expect.objectContaining({ reason: 'COUPON_CUSTOMER_LIMIT', message: 'Ya usaste este cupón' })]);
      // Otro cliente sí puede.
      const other = await promotions.evaluate({ tenantId: t.tenantId, userId: null, email: 'nuevo@correo.ec', couponCodes: ['BIENVENIDA'], lines: LINES });
      expect(other.applied).toHaveLength(1);
    });

    it('el uso como invitado (email) cuenta cuando luego compra registrado con ese email', async () => {
      const promo = await createPromotion({ type: 'fixed', benefit: { amount: '5' }, requiresCoupon: true });
      const coupon = await createCoupon(promo.id, { code: 'PRIMERA' });
      const customer = await createCustomer(db, t.tenantId);
      await redeem(promo.id, coupon.id, { email: 'Ana@Correo.EC' });
      await expect(redeem(promo.id, coupon.id, { userId: customer, email: 'ana@correo.ec' })).rejects.toMatchObject({
        code: 'COUPON_CUSTOMER_LIMIT',
      });
    });

    it('cupón personal: otro cliente no lo canjea y no se consume el cupo', async () => {
      const promo = await createPromotion({ type: 'fixed', benefit: { amount: '5' }, requiresCoupon: true });
      const owner = await createCustomer(db, t.tenantId);
      const intruder = await createCustomer(db, t.tenantId);
      const coupon = await createCoupon(promo.id, { code: 'VIPANA', assignedUserId: owner });
      await expect(redeem(promo.id, coupon.id, { userId: intruder })).rejects.toMatchObject({ code: 'COUPON_NOT_ASSIGNED' });
      expect(await counters(promo.id, coupon.id)).toEqual({ promotion: 0, coupon: 0, redemptions: 0 });
      await expect(redeem(promo.id, coupon.id, { userId: owner })).resolves.toHaveLength(1);
    });

    it('todo o nada: si un cupón del pedido falla, no se consume el otro', async () => {
      const a = await createPromotion({ type: 'fixed', benefit: { amount: '5' }, requiresCoupon: true, stackable: true });
      const b = await createPromotion({ type: 'fixed', benefit: { amount: '3' }, requiresCoupon: true, stackable: true });
      const ca = await createCoupon(a.id, { code: 'PARTE-A' });
      const cb = await createCoupon(b.id, { code: 'PARTE-B', maxUses: 1 });
      await redeem(b.id, cb.id, { email: 'primero@correo.ec' });
      await expect(
        promotions.redeem({
          tenantId: t.tenantId,
          orderId: randomUUID(),
          userId: null,
          email: 'segundo@correo.ec',
          promotions: [
            { promotionId: a.id, couponId: ca.id, discount: '5.00' },
            { promotionId: b.id, couponId: cb.id, discount: '3.00' },
          ],
        }),
      ).rejects.toMatchObject({ code: 'COUPON_USAGE_LIMIT' });
      expect(await counters(a.id, ca.id)).toEqual({ promotion: 0, coupon: 0, redemptions: 0 });
    });

    it('idempotente por pedido: reintentos (también simultáneos) no consumen más cupos', async () => {
      const promo = await createPromotion({ type: 'fixed', benefit: { amount: '5' }, requiresCoupon: true });
      const coupon = await createCoupon(promo.id, { code: 'REINTENTO', maxUses: 10 });
      const orderId = randomUUID();
      const results = await Promise.all(Array.from({ length: 4 }, () => redeem(promo.id, coupon.id, { email: 'r@correo.ec' }, orderId)));
      const ids = new Set(results.flat().map((r) => r.id));
      expect(ids.size).toBe(1);
      expect(await redeem(promo.id, coupon.id, { email: 'r@correo.ec' }, orderId)).toHaveLength(1);
      expect(await counters(promo.id, coupon.id)).toEqual({ promotion: 1, coupon: 1, redemptions: 1 });
    });

    it('revertir (pedido cancelado) devuelve los cupos; es idempotente', async () => {
      const promo = await createPromotion({ type: 'fixed', benefit: { amount: '5' }, requiresCoupon: true });
      const coupon = await createCoupon(promo.id, { code: 'CANCELA', maxUses: 1 });
      const customer = await createCustomer(db, t.tenantId);
      const orderId = randomUUID();
      await redeem(promo.id, coupon.id, { userId: customer }, orderId);
      expect(await promotions.revertRedemptions(t.tenantId, orderId)).toEqual({ reverted: 1 });
      expect(await promotions.revertRedemptions(t.tenantId, orderId)).toEqual({ reverted: 0 });
      expect(await counters(promo.id, coupon.id)).toEqual({ promotion: 0, coupon: 0, redemptions: 0 });
      await expect(redeem(promo.id, coupon.id, { userId: customer })).resolves.toHaveLength(1);
    });

    it('sin usuario ni email no se puede canjear', async () => {
      const promo = await createPromotion({ type: 'fixed', benefit: { amount: '5' } });
      await expect(redeem(promo.id, null, {})).rejects.toMatchObject({ code: 'CUSTOMER_IDENTITY_REQUIRED' });
    });
  });

  describe('gift cards', () => {
    async function issue(amount: string, extra: Record<string, unknown> = {}) {
      const res = await request(server()).post('/v1/gift-cards').set('Authorization', staff).send({ amount, ...extra }).expect(201);
      return res.body as { giftCard: { id: string; last4: string; balance: string; status: string }; code: string };
    }

    const ledger = async (id: string) =>
      (await db.query<{ total: string }>(`SELECT COALESCE(SUM(amount), 0)::text AS total FROM sales.gift_card_transactions WHERE gift_card_id = $1`, [id]))
        .rows[0].total;

    it('emite: el código solo se muestra una vez; la base guarda el hash', async () => {
      const { giftCard, code } = await issue('50.00', { recipientEmail: 'Regalo@Correo.EC' });
      expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
      expect(giftCard).toMatchObject({ balance: '50.00', status: 'active', last4: code.slice(-4), recipientEmail: 'regalo@correo.ec' });
      expect(giftCard).not.toHaveProperty('codeHash');

      const detail = await request(server()).get(`/v1/gift-cards/${giftCard.id}`).set('Authorization', staff).expect(200);
      expect(JSON.stringify(detail.body)).not.toContain(code.replace(/-/g, ''));
      expect(detail.body.transactions).toEqual([expect.objectContaining({ type: 'issue', amount: '50.00', orderId: null })]);
    });

    it('consulta de saldo como invitado (tenant por header); código inexistente o de otro tenant → 404', async () => {
      const { code } = await issue('20');
      const res = await request(server())
        .post('/v1/gift-cards/balance')
        .set('X-Tenant-Id', t.tenantId)
        .send({ code: code.toLowerCase().replace(/-/g, ' ') })
        .expect(200);
      expect(res.body).toMatchObject({ balance: '20.00', status: 'active', last4: code.slice(-4) });
      await request(server()).post('/v1/gift-cards/balance').set('X-Tenant-Id', t.tenantId).send({ code: '0000-0000-0000-0000' }).expect(404);
      const other = await createTenant(db);
      await request(server()).post('/v1/gift-cards/balance').set('X-Tenant-Id', other.tenantId).send({ code }).expect(404);
    });

    it('10 checkouts simultáneos de $10 con una tarjeta de $50: 5 pasan y el saldo nunca es negativo', async () => {
      const { giftCard, code } = await issue('50');
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => promotions.redeemGiftCard(t.tenantId, code, randomUUID(), '10.00')),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
      for (const r of results.filter((x): x is PromiseRejectedResult => x.status === 'rejected')) {
        expect(r.reason).toMatchObject({ code: 'GIFT_CARD_INSUFFICIENT_BALANCE' });
      }
      const balance = await promotions.getGiftCardBalance(t.tenantId, code);
      expect(balance).toMatchObject({ balance: '0.00', status: 'depleted' });
      expect(await ledger(giftCard.id)).toBe('0.00');
    });

    it('canje idempotente por pedido y reembolso que nunca devuelve más de lo canjeado', async () => {
      const { giftCard, code } = await issue('40');
      const orderId = randomUUID();
      const first = await promotions.redeemGiftCard(t.tenantId, code, orderId, '15.50');
      const retry = await promotions.redeemGiftCard(t.tenantId, code, orderId, '15.50');
      expect(first).toMatchObject({ amount: '15.50', balance: '24.50' });
      expect(retry).toMatchObject({ amount: '15.50', balance: '24.50' });

      expect(await promotions.refundGiftCards(t.tenantId, orderId, '5')).toEqual({ refunded: '5.00' });
      await expect(promotions.refundGiftCards(t.tenantId, orderId, '11')).rejects.toMatchObject({ code: 'REFUND_EXCEEDS_REDEEMED' });
      expect(await promotions.refundGiftCards(t.tenantId, orderId)).toEqual({ refunded: '10.50' });
      expect(await promotions.refundGiftCards(t.tenantId, orderId)).toEqual({ refunded: '0.00' });

      const detail = await request(server()).get(`/v1/gift-cards/${giftCard.id}`).set('Authorization', staff).expect(200);
      expect(detail.body.balance).toBe('40.00');
      expect(detail.body.transactions.map((x: { type: string; amount: string }) => [x.type, x.amount])).toEqual([
        ['issue', '40.00'],
        ['redeem', '-15.50'],
        ['refund', '5.00'],
        ['refund', '10.50'],
      ]);
      expect(await ledger(giftCard.id)).toBe('40.00');
    });

    it('ajuste manual, bloqueo y vencimiento', async () => {
      const { giftCard, code } = await issue('10');
      const adjusted = await request(server())
        .post(`/v1/gift-cards/${giftCard.id}/adjust`)
        .set('Authorization', staff)
        .send({ delta: '-2.50' })
        .expect(200);
      expect(adjusted.body).toMatchObject({ balance: '7.50' });
      await request(server()).post(`/v1/gift-cards/${giftCard.id}/adjust`).set('Authorization', staff).send({ delta: '-8' }).expect(409);
      expect(await ledger(giftCard.id)).toBe('7.50');

      await request(server()).post(`/v1/gift-cards/${giftCard.id}/block`).set('Authorization', staff).expect(200);
      await expect(promotions.redeemGiftCard(t.tenantId, code, randomUUID(), '1')).rejects.toMatchObject({ code: 'GIFT_CARD_BLOCKED' });

      const expiring = await issue('10', { expiresAt: '2030-01-01T00:00:00Z' });
      await db.query(`UPDATE sales.gift_cards SET expires_at = now() - interval '1 day' WHERE id = $1`, [expiring.giftCard.id]);
      expect(await promotions.getGiftCardBalance(t.tenantId, expiring.code)).toMatchObject({ status: 'expired', balance: '10.00' });
      await expect(promotions.redeemGiftCard(t.tenantId, expiring.code, randomUUID(), '1')).rejects.toMatchObject({ code: 'GIFT_CARD_EXPIRED' });
    });

    it('pendiente hasta activarla', async () => {
      const { giftCard, code } = await issue('15', { pending: true });
      expect(giftCard.status).toBe('pending');
      await expect(promotions.redeemGiftCard(t.tenantId, code, randomUUID(), '1')).rejects.toMatchObject({ code: 'GIFT_CARD_PENDING' });
      await request(server()).post(`/v1/gift-cards/${giftCard.id}/activate`).set('Authorization', staff).expect(200);
      await expect(promotions.redeemGiftCard(t.tenantId, code, randomUUID(), '1')).resolves.toMatchObject({ balance: '14.00' });
    });

    it('sin giftcards.write no se emiten', async () => {
      await request(server()).post('/v1/gift-cards').set('Authorization', `Bearer ${tokenFor(t, ['giftcards.read'])}`).send({ amount: '5' }).expect(403);
    });
  });
});
