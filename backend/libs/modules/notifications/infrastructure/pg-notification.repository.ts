import { Injectable } from '@nestjs/common';
import { Queryable } from '../../../shared-kernel';
import { NewNotification, NotificationFilter, NotificationRepository, NotificationView, QueuedNotification } from '../application/ports';
import { Channel, NotificationStatus } from '../domain/channel';

/** El texto de error se recorta: un stack o una respuesta SMTP larga no debe inflar la fila. */
const MAX_ERROR = 500;

interface QueuedRow {
  id: string;
  tenant_id: string;
  user_id: string | null;
  channel: Channel;
  template_code: string;
  recipient: string;
  payload: Record<string, unknown>;
  attempts: number;
}

interface ViewRow {
  id: string;
  user_id: string | null;
  channel: Channel;
  template_code: string;
  recipient: string;
  status: NotificationStatus;
  payload: { subject?: string | null; text?: string | null };
  attempts: number;
  error: string | null;
  created_at: Date;
  sent_at: Date | null;
}

@Injectable()
export class PgNotificationRepository extends NotificationRepository {
  async insert(q: Queryable, n: NewNotification): Promise<boolean> {
    const res = await q.query(
      `INSERT INTO platform.notifications
         (tenant_id, user_id, channel, template_code, recipient, payload, status, error, dedupe_key, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, CASE WHEN $7 = 'queued' THEN now() END)
       ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`,
      [n.tenantId, n.userId, n.channel, n.templateCode, n.recipient, JSON.stringify(n.payload), n.status, n.error, n.dedupeKey],
    );
    return res.rowCount === 1;
  }

  async claimDue(q: Queryable, now: Date, limit: number, leaseSeconds: number, tenantId?: string): Promise<QueuedNotification[]> {
    const { rows } = await q.query<QueuedRow>(
      `UPDATE platform.notifications n
          SET next_attempt_at = $1::timestamptz + make_interval(secs => $3)
        WHERE n.id IN (
          SELECT id FROM platform.notifications
           WHERE status = 'queued' AND next_attempt_at <= $1 AND ($4::uuid IS NULL OR tenant_id = $4)
           ORDER BY next_attempt_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED)
       RETURNING n.id, n.tenant_id, n.user_id, n.channel, n.template_code, n.recipient, n.payload, n.attempts`,
      [now, limit, leaseSeconds, tenantId ?? null],
    );
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      userId: r.user_id,
      channel: r.channel,
      templateCode: r.template_code,
      recipient: r.recipient,
      payload: r.payload,
      attempts: r.attempts,
    }));
  }

  async markSent(q: Queryable, id: string, providerMsgId: string | null, attempts: number, now: Date): Promise<void> {
    await q.query(
      `UPDATE platform.notifications
          SET status = 'sent', provider_msg_id = $2, attempts = $3, sent_at = $4, next_attempt_at = NULL, error = NULL
        WHERE id = $1 AND status = 'queued'`,
      [id, providerMsgId, attempts, now],
    );
  }

  async markRetry(q: Queryable, id: string, attempts: number, nextAttemptAt: Date, error: string): Promise<void> {
    await q.query(
      `UPDATE platform.notifications SET attempts = $2, next_attempt_at = $3, error = $4 WHERE id = $1 AND status = 'queued'`,
      [id, attempts, nextAttemptAt, error.slice(0, MAX_ERROR)],
    );
  }

  async markFailed(q: Queryable, id: string, attempts: number, error: string): Promise<void> {
    await q.query(
      `UPDATE platform.notifications SET status = 'failed', attempts = $2, next_attempt_at = NULL, error = $3 WHERE id = $1 AND status = 'queued'`,
      [id, attempts, error.slice(0, MAX_ERROR)],
    );
  }

  async list(q: Queryable, tenantId: string, f: NotificationFilter): Promise<NotificationView[]> {
    const { rows } = await q.query<ViewRow>(
      `SELECT id, user_id, channel, template_code, recipient, status, payload, attempts, error, created_at, sent_at
         FROM platform.notifications
        WHERE tenant_id = $1
          AND ($2::uuid IS NULL OR user_id = $2)
          AND ($3::text[] IS NULL OR status = ANY($3))
          AND ($4::text IS NULL OR channel = $4)
          AND ($5::text IS NULL OR template_code = $5)
        ORDER BY created_at DESC, id
        LIMIT $6 OFFSET $7`,
      [tenantId, f.userId ?? null, f.statuses?.length ? f.statuses : null, f.channel ?? null, f.templateCode ?? null, f.limit, f.offset],
    );
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      channel: r.channel,
      templateCode: r.template_code,
      recipient: r.recipient,
      status: r.status,
      subject: r.payload.subject ?? null,
      text: r.payload.text ?? null,
      attempts: r.attempts,
      error: r.error,
      createdAt: r.created_at,
      sentAt: r.sent_at,
    }));
  }
}
