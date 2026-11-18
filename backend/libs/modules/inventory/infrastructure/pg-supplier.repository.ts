import { Injectable } from '@nestjs/common';
import { buildSetClause, Queryable } from '../../../shared-kernel';
import { NewSupplier, SupplierPatch, SupplierRepository } from '../application/ports';
import { Supplier } from '../domain/supplier';

const COLUMNS = 'id, tenant_id, name, ruc, contact, lead_time_days, active';

const PATCH_COLUMNS: Record<string, string> = {
  name: 'name',
  ruc: 'ruc',
  contact: 'contact',
  leadTimeDays: 'lead_time_days',
  active: 'active',
};

interface SupplierRow {
  id: string;
  tenant_id: string;
  name: string;
  ruc: string | null;
  contact: Supplier['contact'];
  lead_time_days: number | null;
  active: boolean;
}

function toSupplier(r: SupplierRow): Supplier {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    ruc: r.ruc,
    contact: r.contact,
    leadTimeDays: r.lead_time_days,
    active: r.active,
  };
}

@Injectable()
export class PgSupplierRepository extends SupplierRepository {
  async insert(q: Queryable, s: NewSupplier): Promise<Supplier> {
    const { rows } = await q.query<SupplierRow>(
      `INSERT INTO inventory.suppliers (tenant_id, name, ruc, contact, lead_time_days, active)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       RETURNING ${COLUMNS}`,
      [s.tenantId, s.name, s.ruc, JSON.stringify(s.contact), s.leadTimeDays, s.active],
    );
    return toSupplier(rows[0]);
  }

  async findById(q: Queryable, tenantId: string, id: string): Promise<Supplier | null> {
    const { rows } = await q.query<SupplierRow>(
      `SELECT ${COLUMNS} FROM inventory.suppliers WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    return rows[0] ? toSupplier(rows[0]) : null;
  }

  async list(q: Queryable, tenantId: string, filter: { active?: boolean; search?: string }): Promise<Supplier[]> {
    const where = ['tenant_id = $1'];
    const values: unknown[] = [tenantId];
    if (filter.active !== undefined) where.push(`active = $${values.push(filter.active)}`);
    if (filter.search) {
      const p = values.push(`%${filter.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      where.push(`(name ILIKE $${p} OR ruc LIKE $${p})`);
    }
    const { rows } = await q.query<SupplierRow>(
      `SELECT ${COLUMNS} FROM inventory.suppliers WHERE ${where.join(' AND ')} ORDER BY name`,
      values,
    );
    return rows.map(toSupplier);
  }

  async update(q: Queryable, tenantId: string, id: string, patch: SupplierPatch): Promise<Supplier | null> {
    const { sql, values } = buildSetClause({ ...patch }, PATCH_COLUMNS, 3);
    if (!sql) return this.findById(q, tenantId, id);
    const { rows } = await q.query<SupplierRow>(
      `UPDATE inventory.suppliers SET ${sql} WHERE tenant_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
      [tenantId, id, ...values],
    );
    return rows[0] ? toSupplier(rows[0]) : null;
  }
}
