import { Injectable } from '@nestjs/common';
import { Queryable } from '../../../shared-kernel';
import { StoredTemplate, TemplateRepository } from '../application/ports';
import { Channel, TemplateCategory } from '../domain/channel';

interface TemplateRow {
  id: string;
  code: string;
  channel: Channel;
  locale: string;
  subject: string | null;
  body: string;
  category: TemplateCategory;
  active: boolean;
}

const COLUMNS = 'id, code, channel, locale, subject, body, category, active';

@Injectable()
export class PgTemplateRepository extends TemplateRepository {
  async find(q: Queryable, tenantId: string, code: string, channel: Channel, locale: string): Promise<StoredTemplate | null> {
    const { rows } = await q.query<TemplateRow>(
      `SELECT ${COLUMNS} FROM platform.notification_templates WHERE tenant_id = $1 AND code = $2 AND channel = $3 AND locale = $4`,
      [tenantId, code, channel, locale],
    );
    return rows[0] ?? null;
  }

  async listForTenant(q: Queryable, tenantId: string): Promise<StoredTemplate[]> {
    const { rows } = await q.query<TemplateRow>(
      `SELECT ${COLUMNS} FROM platform.notification_templates WHERE tenant_id = $1 ORDER BY code, channel, locale`,
      [tenantId],
    );
    return rows;
  }

  async upsert(q: Queryable, tenantId: string, t: Omit<StoredTemplate, 'id'>): Promise<StoredTemplate> {
    const { rows } = await q.query<TemplateRow>(
      `INSERT INTO platform.notification_templates (tenant_id, code, channel, locale, subject, body, category, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, code, channel, locale)
       DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body, category = EXCLUDED.category, active = EXCLUDED.active
       RETURNING ${COLUMNS}`,
      [tenantId, t.code, t.channel, t.locale, t.subject, t.body, t.category, t.active],
    );
    return rows[0];
  }
}
