import { Injectable } from '@nestjs/common';
import { Queryable } from '../../../shared-kernel';
import { ConsentRepository, NewConsent } from '../application/ports';
import { ConsentPurpose, ConsentRecord } from '../domain/consent';

interface ConsentRow {
  purpose: ConsentPurpose;
  granted: boolean;
  policy_version: string;
  created_at: Date;
}

function toRecord(r: ConsentRow): ConsentRecord {
  return { purpose: r.purpose, granted: r.granted, policyVersion: r.policy_version, createdAt: r.created_at };
}

@Injectable()
export class PgConsentRepository extends ConsentRepository {
  async insert(q: Queryable, c: NewConsent): Promise<void> {
    await q.query(
      `INSERT INTO iam.consents (user_id, guest_email, purpose, policy_version, granted, ip) VALUES ($1, $2, $3, $4, $5, $6)`,
      [c.userId, c.guestEmail, c.purpose, c.policyVersion, c.granted, c.ip],
    );
  }

  async listByUser(q: Queryable, userId: string): Promise<ConsentRecord[]> {
    const { rows } = await q.query<ConsentRow>(
      `SELECT purpose, granted, policy_version, created_at FROM iam.consents WHERE user_id = $1 ORDER BY created_at, id`,
      [userId],
    );
    return rows.map(toRecord);
  }

  async listByGuestEmail(q: Queryable, email: string): Promise<ConsentRecord[]> {
    const { rows } = await q.query<ConsentRow>(
      `SELECT purpose, granted, policy_version, created_at FROM iam.consents
        WHERE user_id IS NULL AND guest_email = $1 ORDER BY created_at, id`,
      [email],
    );
    return rows.map(toRecord);
  }
}
