import { Injectable } from '@nestjs/common';
import { Queryable } from '../../../shared-kernel';
import { WebhookInboxRepository, WebhookInboxRow } from '../application/ports';

@Injectable()
export class PgWebhookInboxRepository extends WebhookInboxRepository {
  async insert(
    q: Queryable,
    row: { provider: string; externalId: string; payload: unknown; signatureValid: boolean; error: string | null },
  ): Promise<string | null> {
    // Con firma inválida no hay nada que procesar: queda registrado y cerrado.
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO payments.webhook_inbox (provider, external_id, payload, signature_valid, error, processed_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, CASE WHEN $4 THEN NULL ELSE now() END)
       ON CONFLICT (provider, external_id) DO NOTHING
       RETURNING id`,
      [row.provider, row.externalId, JSON.stringify(row.payload), row.signatureValid, row.error],
    );
    return rows[0] ? String(rows[0].id) : null;
  }

  async findForUpdate(q: Queryable, provider: string, externalId: string): Promise<WebhookInboxRow | null> {
    const { rows } = await q.query<{
      id: string;
      provider: string;
      external_id: string;
      signature_valid: boolean;
      processed_at: Date | null;
      error: string | null;
    }>(
      `SELECT id, provider, external_id, signature_valid, processed_at, error
         FROM payments.webhook_inbox WHERE provider = $1 AND external_id = $2 FOR UPDATE`,
      [provider, externalId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: String(r.id),
      provider: r.provider,
      externalId: r.external_id,
      signatureValid: r.signature_valid,
      processedAt: r.processed_at,
      error: r.error,
    };
  }

  async replaceWithValid(q: Queryable, id: string, payload: unknown): Promise<void> {
    await q.query(
      `UPDATE payments.webhook_inbox
          SET payload = $2::jsonb, signature_valid = true, error = NULL, processed_at = NULL, received_at = now()
        WHERE id = $1`,
      [id, JSON.stringify(payload)],
    );
  }

  async markProcessed(q: Queryable, id: string, error: string | null): Promise<void> {
    await q.query(`UPDATE payments.webhook_inbox SET processed_at = now(), error = $2 WHERE id = $1`, [id, error]);
  }
}
