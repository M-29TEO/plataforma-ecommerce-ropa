import { Injectable } from '@nestjs/common';
import { Queryable } from '../../../shared-kernel';
import { CustomerSummary, UserContact, UserDirectory } from '../application/ports';

interface ContactRow {
  id: string;
  tenant_id: string;
  user_type: UserContact['userType'];
  email: string;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  locale: string;
  status: UserContact['status'];
}

/** Columnas de la búsqueda de clientes: sin password_hash, mfa_secret_enc ni datos de sesión. */
const CUSTOMER_COLUMNS = `id, email::text AS email, first_name, last_name, phone, id_type, id_number, status`;

interface CustomerRow {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  id_type: string | null;
  id_number: string | null;
  status: CustomerSummary['status'];
}

function toCustomer(r: CustomerRow): CustomerSummary {
  return {
    userId: r.id,
    email: r.email,
    firstName: r.first_name,
    lastName: r.last_name,
    phone: r.phone,
    idType: r.id_type,
    idNumber: r.id_number,
    status: r.status,
  };
}

@Injectable()
export class PgUserDirectory extends UserDirectory {
  async findContact(q: Queryable, tenantId: string, userId: string): Promise<UserContact | null> {
    const { rows } = await q.query<ContactRow>(
      `SELECT id, tenant_id, user_type, email::text AS email, phone, first_name, last_name, locale, status
         FROM iam.users
        WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [tenantId, userId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      userId: r.id,
      tenantId: r.tenant_id,
      userType: r.user_type,
      email: r.email,
      phone: r.phone,
      firstName: r.first_name,
      lastName: r.last_name,
      locale: r.locale,
      status: r.status,
    };
  }

  async searchCustomers(q: Queryable, tenantId: string, term: string, limit: number): Promise<CustomerSummary[]> {
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const { rows } = await q.query<CustomerRow>(
      `SELECT ${CUSTOMER_COLUMNS}
         FROM iam.users
        WHERE tenant_id = $1 AND user_type = 'customer' AND deleted_at IS NULL AND status <> 'anonymized'
          AND (email ILIKE $2 OR first_name ILIKE $2 OR last_name ILIKE $2
               OR (coalesce(first_name, '') || ' ' || coalesce(last_name, '')) ILIKE $2
               OR phone ILIKE $2 OR id_number ILIKE $2)
        ORDER BY (email = $3) DESC, (id_number = $3) DESC, last_name NULLS LAST, first_name NULLS LAST, email
        LIMIT $4`,
      [tenantId, like, term, limit],
    );
    return rows.map(toCustomer);
  }

  async findCustomer(q: Queryable, tenantId: string, userId: string): Promise<CustomerSummary | null> {
    const { rows } = await q.query<CustomerRow>(
      `SELECT ${CUSTOMER_COLUMNS}
         FROM iam.users
        WHERE tenant_id = $1 AND id = $2 AND user_type = 'customer' AND deleted_at IS NULL AND status <> 'anonymized'`,
      [tenantId, userId],
    );
    return rows[0] ? toCustomer(rows[0]) : null;
  }

  async findIdByEmail(q: Queryable, tenantId: string, email: string): Promise<string | null> {
    const { rows } = await q.query<{ id: string }>(
      `SELECT id FROM iam.users WHERE tenant_id = $1 AND email = $2 AND deleted_at IS NULL`,
      [tenantId, email],
    );
    return rows[0]?.id ?? null;
  }

  async staffHasPermission(q: Queryable, tenantId: string, userId: string, permission: string): Promise<boolean> {
    const { rows } = await q.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM iam.users u
           JOIN iam.user_roles ur ON ur.user_id = u.id
           JOIN iam.roles r ON r.id = ur.role_id AND r.tenant_id = u.tenant_id
           JOIN iam.role_permissions rp ON rp.role_id = r.id
          WHERE u.tenant_id = $1 AND u.id = $2 AND u.user_type = 'staff' AND u.status = 'active'
            AND u.deleted_at IS NULL AND rp.permission_code = $3
       ) AS ok`,
      [tenantId, userId, permission],
    );
    return rows[0].ok;
  }
}
