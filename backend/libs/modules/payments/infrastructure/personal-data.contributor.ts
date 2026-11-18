import { Injectable, OnModuleInit } from '@nestjs/common';
import { AnonymizationResult, Database, DataSubject, PersonalDataContributor, PersonalDataRegistry } from '../../../shared-kernel';

/**
 * Derechos LOPDP del titular en el schema payments.
 *
 * Exporta: tarjetas guardadas (marca, últimos 4, vencimiento; nunca token_enc) y los pagos de sus
 * pedidos (subject.orderIds, que aporta Pedidos): método, monto, estado y fechas.
 * Anonimiza: borra las tarjetas guardadas (customer_payment_tokens). No tiene tenant_id ni otra fila
 * padre en este schema: se ubica por user_id, que es un uuid de un solo tenant.
 * Conserva: pagos, reembolsos y comprobantes de transferencia (registros contables y tributarios;
 * no guardan datos de contacto, solo marca y últimos 4 de la tarjeta).
 */
@Injectable()
export class PaymentsPersonalDataContributor extends PersonalDataContributor implements OnModuleInit {
  override readonly section = 'pagos';

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
    const { rows: cards } = await this.db.query<{
      provider: string;
      brand: string | null;
      last4: string | null;
      exp_month: number | null;
      exp_year: number | null;
      is_default: boolean;
      created_at: Date;
    }>(
      `SELECT provider, brand, last4, exp_month, exp_year, is_default, created_at
         FROM payments.customer_payment_tokens WHERE user_id = $1
        ORDER BY created_at, id`,
      [s.userId],
    );
    const { rows: payments } = s.orderIds.length
      ? await this.db.query<{
          order_id: string;
          method: string;
          amount: string;
          currency: string;
          status: string;
          card_brand: string | null;
          card_last4: string | null;
          installments: number | null;
          captured_at: Date | null;
          created_at: Date;
        }>(
          `SELECT order_id, method, amount, currency, status, card_brand, card_last4, installments, captured_at, created_at
             FROM payments.payments WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])
            ORDER BY created_at, id`,
          [s.tenantId, s.orderIds],
        )
      : { rows: [] };
    return {
      savedCards: cards.map((c) => ({
        provider: c.provider,
        brand: c.brand,
        last4: c.last4,
        expMonth: c.exp_month,
        expYear: c.exp_year,
        isDefault: c.is_default,
        createdAt: c.created_at.toISOString(),
      })),
      payments: payments.map((p) => ({
        orderId: p.order_id,
        method: p.method,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        cardBrand: p.card_brand,
        cardLast4: p.card_last4,
        installments: p.installments,
        capturedAt: p.captured_at ? p.captured_at.toISOString() : null,
        createdAt: p.created_at.toISOString(),
      })),
    };
  }

  override async anonymize(s: DataSubject): Promise<AnonymizationResult> {
    const r = await this.db.query(`DELETE FROM payments.customer_payment_tokens WHERE user_id = $1`, [s.userId]);
    return {
      affected: r.rowCount ?? 0,
      retained: ['Pagos, reembolsos y comprobantes de transferencia: registros contables y tributarios'],
    };
  }
}
