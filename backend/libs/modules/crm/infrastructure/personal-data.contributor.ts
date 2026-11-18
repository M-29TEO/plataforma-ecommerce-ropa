import { Injectable, OnModuleInit } from '@nestjs/common';
import { AnonymizationResult, Database, DataSubject, PersonalDataContributor, PersonalDataRegistry } from '../../../shared-kernel';

/**
 * Derechos LOPDP del titular en el schema crm.
 *
 * Exporta: perfil de cliente (fecha de nacimiento, género, tallas, estilos, código de referido y
 * contadores), direcciones, wishlist, cuenta de puntos con sus movimientos y referidos (solo el rol
 * propio y las fechas: el otro cliente no se identifica).
 * Anonimiza: borra direcciones y wishlist; vacía los datos del perfil (los contadores se quedan:
 * son agregados de compras, no datos de contacto). Quitar referral_code impide que alguien más se
 * registre con el código de una cuenta anonimizada.
 * Conserva: saldo y movimientos de puntos (obligación pendiente con el cliente) y los referidos
 * (solo enlazan ids, el premio ya otorgado no se revierte).
 */
@Injectable()
export class CrmPersonalDataContributor extends PersonalDataContributor implements OnModuleInit {
  override readonly section = 'cliente';

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
    const params = [s.tenantId, s.userId];
    const { rows: profiles } = await this.db.query<{
      birthdate: string | null;
      gender: string | null;
      size_preferences: Record<string, unknown>;
      style_tags: string[];
      referral_code: string | null;
      orders_count: number;
      lifetime_value: string;
      last_order_at: Date | null;
    }>(
      `SELECT birthdate, gender, size_preferences, style_tags, referral_code, orders_count, lifetime_value, last_order_at
         FROM crm.customer_profiles WHERE tenant_id = $1 AND user_id = $2`,
      params,
    );
    const { rows: addresses } = await this.db.query<{
      label: string | null;
      recipient_name: string;
      recipient_phone: string;
      province: string;
      city: string;
      parish: string | null;
      neighborhood: string | null;
      main_street: string;
      cross_street: string | null;
      house_number: string | null;
      reference: string | null;
      lat: number | null;
      lng: number | null;
      is_default: boolean;
      created_at: Date;
    }>(
      `SELECT label, recipient_name, recipient_phone, province, city, parish, neighborhood, main_street, cross_street,
              house_number, reference, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng, is_default, created_at
         FROM crm.addresses WHERE tenant_id = $1 AND user_id = $2
        ORDER BY is_default DESC, created_at, id`,
      params,
    );
    const { rows: wishlist } = await this.db.query<{ product_id: string; variant_id: string | null; added_at: Date }>(
      `SELECT product_id, variant_id, added_at FROM crm.wishlist_items WHERE tenant_id = $1 AND user_id = $2 ORDER BY added_at, product_id`,
      params,
    );
    const { rows: accounts } = await this.db.query<{
      points_balance: number;
      points_pending: number;
      lifetime_points: number;
      tier: string | null;
      updated_at: Date;
    }>(
      `SELECT a.points_balance, a.points_pending, a.lifetime_points, t.name AS tier, a.updated_at
         FROM crm.loyalty_accounts a
         LEFT JOIN crm.loyalty_tiers t ON t.id = a.tier_id AND t.tenant_id = a.tenant_id
        WHERE a.tenant_id = $1 AND a.user_id = $2`,
      params,
    );
    const { rows: movements } = await this.db.query<{
      type: string;
      points: number;
      status: string;
      order_id: string | null;
      reference: string | null;
      available_at: Date | null;
      expires_at: Date | null;
      created_at: Date;
    }>(
      `SELECT type, points, status, order_id, reference, available_at, expires_at, created_at
         FROM crm.loyalty_transactions WHERE tenant_id = $1 AND user_id = $2
        ORDER BY created_at, id`,
      params,
    );
    // Del otro cliente del referido no se exporta nada (ni su id): son datos de un tercero.
    const { rows: referrals } = await this.db.query<{ role: 'referrer' | 'referee'; status: string; rewarded_at: Date | null; created_at: Date }>(
      `SELECT CASE WHEN referrer_id = $2 THEN 'referrer' ELSE 'referee' END AS role, status, rewarded_at, created_at
         FROM crm.referrals
        WHERE tenant_id = $1 AND (referrer_id = $2 OR referee_id = $2)
        ORDER BY created_at, id`,
      params,
    );

    const p = profiles[0];
    const a = accounts[0];
    return {
      profile: p
        ? {
            birthdate: p.birthdate,
            gender: p.gender,
            sizePreferences: p.size_preferences,
            styleTags: p.style_tags,
            referralCode: p.referral_code,
            ordersCount: p.orders_count,
            lifetimeValue: p.lifetime_value,
            lastOrderAt: iso(p.last_order_at),
          }
        : null,
      addresses: addresses.map((r) => ({
        label: r.label,
        recipientName: r.recipient_name,
        recipientPhone: r.recipient_phone,
        province: r.province,
        city: r.city,
        parish: r.parish,
        neighborhood: r.neighborhood,
        mainStreet: r.main_street,
        crossStreet: r.cross_street,
        houseNumber: r.house_number,
        reference: r.reference,
        lat: r.lat,
        lng: r.lng,
        isDefault: r.is_default,
        createdAt: iso(r.created_at),
      })),
      wishlist: wishlist.map((w) => ({ productId: w.product_id, variantId: w.variant_id, addedAt: iso(w.added_at) })),
      loyalty: a
        ? {
            points: a.points_balance,
            pendingPoints: a.points_pending,
            lifetimePoints: a.lifetime_points,
            tier: a.tier,
            updatedAt: iso(a.updated_at),
            transactions: movements.map((m) => ({
              type: m.type,
              points: m.points,
              status: m.status,
              orderId: m.order_id,
              reference: m.reference,
              availableAt: iso(m.available_at),
              expiresAt: iso(m.expires_at),
              createdAt: iso(m.created_at),
            })),
          }
        : null,
      referrals: {
        referredCount: referrals.filter((r) => r.role === 'referrer').length,
        items: referrals.map((r) => ({ role: r.role, status: r.status, rewardedAt: iso(r.rewarded_at), createdAt: iso(r.created_at) })),
      },
    };
  }

  override async anonymize(s: DataSubject): Promise<AnonymizationResult> {
    const params = [s.tenantId, s.userId];
    const results = [
      await this.db.query(`DELETE FROM crm.addresses WHERE tenant_id = $1 AND user_id = $2`, params),
      await this.db.query(`DELETE FROM crm.wishlist_items WHERE tenant_id = $1 AND user_id = $2`, params),
      await this.db.query(
        `UPDATE crm.customer_profiles
            SET birthdate = NULL, gender = NULL, size_preferences = '{}', style_tags = '{}', referral_code = NULL
          WHERE tenant_id = $1 AND user_id = $2`,
        params,
      ),
    ];
    return {
      affected: results.reduce((n, r) => n + (r.rowCount ?? 0), 0),
      retained: ['Saldo y movimientos de puntos (sin datos de contacto): obligaciones pendientes con el cliente'],
    };
  }
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}
