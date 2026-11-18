import { Injectable } from '@nestjs/common';
import { Queryable } from '../../../shared-kernel';
import { NewRefreshToken, RefreshTokenRepository } from '../application/ports';
import { StoredRefreshToken } from '../domain/refresh-token';

interface Row {
  id: string;
  user_id: string;
  family_id: string;
  expires_at: Date;
  revoked_at: Date | null;
}

@Injectable()
export class PgRefreshTokenRepository extends RefreshTokenRepository {
  async insert(q: Queryable, t: NewRefreshToken): Promise<void> {
    await q.query(
      `INSERT INTO iam.refresh_tokens (user_id, family_id, token_hash, user_agent, ip, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [t.userId, t.familyId, t.tokenHash, t.userAgent?.slice(0, 512) ?? null, t.ip, t.expiresAt],
    );
  }

  async findByHashForUpdate(q: Queryable, tokenHash: Buffer): Promise<StoredRefreshToken | null> {
    const { rows } = await q.query<Row>(
      `SELECT id, user_id, family_id, expires_at, revoked_at FROM iam.refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
      [tokenHash],
    );
    const r = rows[0];
    return r ? { id: r.id, userId: r.user_id, familyId: r.family_id, expiresAt: r.expires_at, revokedAt: r.revoked_at } : null;
  }

  async revoke(q: Queryable, id: string, now: Date): Promise<void> {
    await q.query(`UPDATE iam.refresh_tokens SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL`, [id, now]);
  }

  async revokeFamily(q: Queryable, familyId: string, now: Date): Promise<number> {
    const { rowCount } = await q.query(
      `UPDATE iam.refresh_tokens SET revoked_at = $2 WHERE family_id = $1 AND revoked_at IS NULL`,
      [familyId, now],
    );
    return rowCount ?? 0;
  }

  async revokeAllForUser(q: Queryable, userId: string, now: Date): Promise<number> {
    const { rowCount } = await q.query(
      `UPDATE iam.refresh_tokens SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId, now],
    );
    return rowCount ?? 0;
  }
}
