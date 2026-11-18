import { Injectable } from '@nestjs/common';
import { Queryable } from '../../../shared-kernel';
import { AddressRepository } from '../application/ports';
import { AddressProps, GeocodeAccuracy } from '../domain/address';

interface AddressRow {
  id: string;
  tenant_id: string;
  user_id: string;
  label: string | null;
  recipient_name: string;
  recipient_phone: string;
  province: string;
  city: string;
  parish: string | null;
  neighborhood: string | null;
  main_street: string;
  cross_street: string | null;
  house_number: string | null;
  reference: string | null;
  lat: number | null;
  lng: number | null;
  geocode_accuracy: GeocodeAccuracy | null;
  is_default: boolean;
  created_at: Date;
}

const COLUMNS = `id, tenant_id, user_id, label, recipient_name, recipient_phone, province, city, parish, neighborhood,
  main_street, cross_street, house_number, reference,
  ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng, geocode_accuracy, is_default, created_at`;

function toProps(r: AddressRow): AddressProps {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    userId: r.user_id,
    label: r.label,
    recipientName: r.recipient_name,
    recipientPhone: r.recipient_phone,
    province: r.province,
    city: r.city,
    parish: r.parish,
    neighborhood: r.neighborhood,
    mainStreet: r.main_street,
    crossStreet: r.cross_street,
    houseNumber: r.house_number,
    reference: r.reference,
    location: r.lat !== null && r.lng !== null ? { lat: r.lat, lng: r.lng } : null,
    geocodeAccuracy: r.geocode_accuracy,
    isDefault: r.is_default,
    createdAt: r.created_at,
  };
}

function values(a: AddressProps): unknown[] {
  return [
    a.label,
    a.recipientName,
    a.recipientPhone,
    a.province,
    a.city,
    a.parish,
    a.neighborhood,
    a.mainStreet,
    a.crossStreet,
    a.houseNumber,
    a.reference,
    a.location?.lng ?? null,
    a.location?.lat ?? null,
    a.geocodeAccuracy,
    a.isDefault,
  ];
}

/** $n del punto: NULL si no hay ubicación. */
const POINT = (lngParam: number) =>
  `CASE WHEN $${lngParam}::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($${lngParam}::float8, $${lngParam + 1}::float8), 4326)::geography END`;

@Injectable()
export class PgAddressRepository extends AddressRepository {
  async lockOwner(q: Queryable, tenantId: string, userId: string): Promise<void> {
    await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`crm.addresses:${tenantId}:${userId}`]);
  }

  async insert(q: Queryable, a: AddressProps): Promise<void> {
    await q.query(
      `INSERT INTO crm.addresses (label, recipient_name, recipient_phone, province, city, parish, neighborhood,
         main_street, cross_street, house_number, reference, location, geocode_accuracy, is_default,
         id, tenant_id, user_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, ${POINT(12)}, $14, $15, $16, $17, $18, $19)`,
      [...values(a), a.id, a.tenantId, a.userId, a.createdAt],
    );
  }

  async update(q: Queryable, a: AddressProps): Promise<void> {
    await q.query(
      `UPDATE crm.addresses SET label = $1, recipient_name = $2, recipient_phone = $3, province = $4, city = $5,
              parish = $6, neighborhood = $7, main_street = $8, cross_street = $9, house_number = $10, reference = $11,
              location = ${POINT(12)}, geocode_accuracy = $14, is_default = $15
        WHERE id = $16 AND tenant_id = $17 AND user_id = $18`,
      [...values(a), a.id, a.tenantId, a.userId],
    );
  }

  async findById(q: Queryable, tenantId: string, userId: string, id: string): Promise<AddressProps | null> {
    const { rows } = await q.query<AddressRow>(`SELECT ${COLUMNS} FROM crm.addresses WHERE tenant_id = $1 AND user_id = $2 AND id = $3`, [
      tenantId,
      userId,
      id,
    ]);
    return rows[0] ? toProps(rows[0]) : null;
  }

  async list(q: Queryable, tenantId: string, userId: string): Promise<AddressProps[]> {
    const { rows } = await q.query<AddressRow>(
      `SELECT ${COLUMNS} FROM crm.addresses WHERE tenant_id = $1 AND user_id = $2 ORDER BY is_default DESC, created_at DESC, id`,
      [tenantId, userId],
    );
    return rows.map(toProps);
  }

  async count(q: Queryable, tenantId: string, userId: string): Promise<number> {
    const { rows } = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM crm.addresses WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
    return rows[0].n;
  }

  async delete(q: Queryable, tenantId: string, userId: string, id: string): Promise<boolean> {
    const r = await q.query(`DELETE FROM crm.addresses WHERE tenant_id = $1 AND user_id = $2 AND id = $3`, [tenantId, userId, id]);
    return (r.rowCount ?? 0) > 0;
  }

  async clearDefault(q: Queryable, tenantId: string, userId: string): Promise<void> {
    await q.query(`UPDATE crm.addresses SET is_default = false WHERE tenant_id = $1 AND user_id = $2 AND is_default`, [tenantId, userId]);
  }

  async promoteLatestAsDefault(q: Queryable, tenantId: string, userId: string): Promise<void> {
    await q.query(
      `UPDATE crm.addresses SET is_default = true
        WHERE id = (SELECT id FROM crm.addresses WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at DESC, id LIMIT 1)`,
      [tenantId, userId],
    );
  }
}
