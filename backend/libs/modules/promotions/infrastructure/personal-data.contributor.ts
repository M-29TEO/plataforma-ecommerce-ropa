import { Injectable, OnModuleInit } from '@nestjs/common';
import { AnonymizationResult, Database, DataSubject, PersonalDataContributor, PersonalDataRegistry } from '../../../shared-kernel';

/**
 * Derechos LOPDP del titular en promociones y gift cards (schema sales, módulo Promociones).
 *
 * Exporta: cupones asignados al titular (código, promoción, estado), sus canjes (fecha, descuento,
 * cupón) y las gift cards que compró o recibió (saldo, estado y últimos 4 del código; nunca el
 * código completo ni su hash).
 * Anonimiza: customer_key de sus canjes pasa a 'anon:<userId>' (también los que hizo como invitado
 * con su email: 'email:<email>'), así los límites por cliente siguen contando sin guardar el email
 * (countCustomerUses también cuenta por user_id). Las gift cards dirigidas a su email quedan sin
 * recipient_email.
 * Conserva: los canjes y las gift cards (montos y saldos), para controlar límites y el saldo a favor.
 */
@Injectable()
export class PromotionsPersonalDataContributor extends PersonalDataContributor implements OnModuleInit {
  override readonly section = 'promociones';

  constructor(
    private readonly registry: PersonalDataRegistry,
    private readonly db: Database,
  ) {
    super();
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  override async exportData(s: DataSubject): Promise<unknown> {
    const { rows: coupons } = await this.db.query<{ code: string; promotion: string; status: string; ends_at: Date | null }>(
      `SELECT c.code::text AS code, p.name AS promotion, p.ends_at,
              CASE WHEN NOT p.active THEN 'inactive'
                   WHEN p.ends_at IS NOT NULL AND p.ends_at <= now() THEN 'expired'
                   WHEN c.max_uses IS NOT NULL AND c.used_count >= c.max_uses THEN 'exhausted'
                   ELSE 'active' END AS status
         FROM sales.coupons c
         JOIN sales.promotions p ON p.id = c.promotion_id AND p.tenant_id = c.tenant_id
        WHERE c.tenant_id = $1 AND c.assigned_user_id = $2
        ORDER BY p.starts_at, c.code`,
      [s.tenantId, s.userId],
    );
    const { rows: redemptions } = await this.db.query<{ promotion: string; coupon_code: string | null; discount: string; created_at: Date }>(
      `SELECT p.name AS promotion, c.code::text AS coupon_code, r.discount, r.created_at
         FROM sales.promotion_redemptions r
         JOIN sales.promotions p ON p.id = r.promotion_id AND p.tenant_id = $1
         LEFT JOIN sales.coupons c ON c.id = r.coupon_id
        WHERE r.user_id = $2::uuid OR ($3::text IS NOT NULL AND r.customer_key = 'email:' || lower($3::text))
        ORDER BY r.created_at, r.id`,
      [s.tenantId, s.userId, s.email],
    );
    const { rows: giftCards } = await this.db.query<{
      last4: string;
      initial_amount: string;
      balance: string;
      currency: string;
      status: string;
      purchaser: boolean;
      recipient: boolean;
      expires_at: Date | null;
      created_at: Date;
    }>(
      `SELECT last4, initial_amount, balance, currency, status, expires_at, created_at,
              purchaser_id IS NOT DISTINCT FROM $2::uuid AS purchaser,
              ($3::text IS NOT NULL AND recipient_email = $3::text::citext) AS recipient
         FROM sales.gift_cards
        WHERE tenant_id = $1 AND (purchaser_id = $2::uuid OR ($3::text IS NOT NULL AND recipient_email = $3::text::citext))
        ORDER BY created_at, id`,
      [s.tenantId, s.userId, s.email],
    );
    return {
      coupons: coupons.map((c) => ({ code: c.code, promotion: c.promotion, status: c.status, endsAt: iso(c.ends_at) })),
      redemptions: redemptions.map((r) => ({
        promotion: r.promotion,
        couponCode: r.coupon_code,
        discount: r.discount,
        createdAt: iso(r.created_at),
      })),
      giftCards: giftCards.map((g) => ({
        last4: g.last4,
        roles: [...(g.purchaser ? ['purchaser'] : []), ...(g.recipient ? ['recipient'] : [])],
        initialAmount: g.initial_amount,
        balance: g.balance,
        currency: g.currency,
        status: g.status,
        expiresAt: iso(g.expires_at),
        createdAt: iso(g.created_at),
      })),
    };
  }

  override async anonymize(s: DataSubject): Promise<AnonymizationResult> {
    // promotion_redemptions no tiene tenant_id: el tenant se asegura con su promoción.
    const redemptions = await this.db.query(
      `UPDATE sales.promotion_redemptions r SET customer_key = 'anon:' || $2::uuid
        WHERE r.promotion_id IN (SELECT id FROM sales.promotions WHERE tenant_id = $1)
          AND (r.user_id = $2::uuid OR ($3::text IS NOT NULL AND r.customer_key = 'email:' || lower($3::text)))
          AND r.customer_key <> 'anon:' || $2::uuid`,
      [s.tenantId, s.userId, s.email],
    );
    const giftCards = s.email
      ? await this.db.query(`UPDATE sales.gift_cards SET recipient_email = NULL WHERE tenant_id = $1 AND recipient_email = $2::text::citext`, [
          s.tenantId,
          s.email,
        ])
      : { rowCount: 0 };
    return {
      affected: (redemptions.rowCount ?? 0) + (giftCards.rowCount ?? 0),
      retained: ['Canjes de promociones y gift cards (sin email): control de límites y saldo a favor'],
    };
  }
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}
