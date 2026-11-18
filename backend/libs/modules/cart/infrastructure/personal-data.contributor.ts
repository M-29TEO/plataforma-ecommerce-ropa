import { Injectable, OnModuleInit } from '@nestjs/common';
import { AnonymizationResult, Database, DataSubject, PersonalDataContributor, PersonalDataRegistry } from '../../../shared-kernel';

/**
 * Derechos LOPDP del titular en sales.carts y cart_items (schema sales, módulo Carrito).
 *
 * Exporta: el carrito activo (variantes y cantidades) y el email/teléfono de contacto que el
 * titular dejó en sus carritos (con ellos se envían los recordatorios de carrito abandonado).
 * Anonimiza: borra los carritos no convertidos (cart_items cae por ON DELETE CASCADE); en los
 * convertidos solo quita el contacto (sales.orders.cart_id los referencia, sin FK).
 * Conserva: nada con datos personales.
 */
@Injectable()
export class CartPersonalDataContributor extends PersonalDataContributor implements OnModuleInit {
  override readonly section = 'carrito';

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
    const { rows: items } = await this.db.query<{ variant_id: string; quantity: number; added_at: Date }>(
      `SELECT i.variant_id, i.quantity, i.added_at
         FROM sales.cart_items i
         JOIN sales.carts c ON c.id = i.cart_id
        WHERE c.tenant_id = $1 AND c.user_id = $2 AND c.status = 'active'
        ORDER BY i.added_at, i.variant_id`,
      [s.tenantId, s.userId],
    );
    const { rows: contacts } = await this.db.query<{ contact_email: string | null; contact_phone: string | null }>(
      `SELECT DISTINCT contact_email::text AS contact_email, contact_phone
         FROM sales.carts
        WHERE tenant_id = $1 AND user_id = $2 AND (contact_email IS NOT NULL OR contact_phone IS NOT NULL)`,
      [s.tenantId, s.userId],
    );
    return {
      activeCart: items.map((i) => ({ variantId: i.variant_id, quantity: i.quantity, addedAt: i.added_at.toISOString() })),
      contacts: contacts.map((c) => ({ email: c.contact_email, phone: c.contact_phone })),
    };
  }

  override async anonymize(s: DataSubject): Promise<AnonymizationResult> {
    const params = [s.tenantId, s.userId];
    const deleted = await this.db.query(`DELETE FROM sales.carts WHERE tenant_id = $1 AND user_id = $2 AND status <> 'converted'`, params);
    const cleared = await this.db.query(
      `UPDATE sales.carts SET contact_email = NULL, contact_phone = NULL
        WHERE tenant_id = $1 AND user_id = $2 AND status = 'converted'
          AND (contact_email IS NOT NULL OR contact_phone IS NOT NULL)`,
      params,
    );
    return { affected: (deleted.rowCount ?? 0) + (cleared.rowCount ?? 0) };
  }
}
