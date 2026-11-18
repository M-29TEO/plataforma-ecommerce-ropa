import { Injectable } from '@nestjs/common';
import { FieldCipher, Queryable } from '../../../shared-kernel';
import { PushSubscriptionRecord, PushSubscriptionRepository } from '../application/ports';

interface Row {
  id: string;
  user_id: string;
  endpoint: string;
  keys_enc: Buffer;
}

/**
 * platform.push_subscriptions. Las claves del navegador (p256dh y el secreto `auth`, con los que
 * se cifra cada mensaje push) se guardan juntas en keys_enc, cifradas con libsodium
 * (FieldCipher, DATA_ENCRYPTION_KEY): un volcado de la base no permite leer ni falsificar pushes.
 */
@Injectable()
export class PgPushSubscriptionRepository extends PushSubscriptionRepository {
  constructor(private readonly cipher: FieldCipher) {
    super();
  }

  async upsert(q: Queryable, s: Omit<PushSubscriptionRecord, 'id'> & { userAgent: string | null }): Promise<string | null> {
    const keysEnc = await this.cipher.sealString(JSON.stringify({ p256dh: s.p256dh, auth: s.auth }));
    // El WHERE del DO UPDATE impide reasignar un endpoint de otro usuario: entonces no hay fila.
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO platform.push_subscriptions (user_id, endpoint, keys_enc, user_agent)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE
         SET keys_enc = EXCLUDED.keys_enc, user_agent = EXCLUDED.user_agent
         WHERE platform.push_subscriptions.user_id = EXCLUDED.user_id
       RETURNING id`,
      [s.userId, s.endpoint, keysEnc, s.userAgent],
    );
    return rows[0]?.id ?? null;
  }

  async listByUser(q: Queryable, userId: string): Promise<PushSubscriptionRecord[]> {
    const { rows } = await q.query<Row>(
      `SELECT id, user_id, endpoint, keys_enc FROM platform.push_subscriptions WHERE user_id = $1 ORDER BY created_at`,
      [userId],
    );
    return Promise.all(rows.map((r) => this.toRecord(r)));
  }

  async findById(q: Queryable, id: string): Promise<PushSubscriptionRecord | null> {
    const { rows } = await q.query<Row>(`SELECT id, user_id, endpoint, keys_enc FROM platform.push_subscriptions WHERE id = $1`, [id]);
    return rows[0] ? this.toRecord(rows[0]) : null;
  }

  async deleteByEndpoint(q: Queryable, endpoint: string, userId?: string): Promise<boolean> {
    const res = await q.query(
      `DELETE FROM platform.push_subscriptions WHERE endpoint = $1 AND ($2::uuid IS NULL OR user_id = $2)`,
      [endpoint, userId ?? null],
    );
    return (res.rowCount ?? 0) > 0;
  }

  private async toRecord(r: Row): Promise<PushSubscriptionRecord> {
    const keys = JSON.parse(await this.cipher.openString(r.keys_enc)) as { p256dh: string; auth: string };
    return { id: r.id, userId: r.user_id, endpoint: r.endpoint, p256dh: keys.p256dh, auth: keys.auth };
  }
}
