import { Injectable } from '@nestjs/common';
import { DatabaseError } from 'pg';
import { Queryable } from '../../../shared-kernel';
import { SlotRepository } from '../application/ports';
import { SlotCapacityBelowBookedError } from '../domain/errors';
import { DeliverySlot, NewDeliverySlot, SlotTemplate, SlotTemplateProps } from '../domain/slot';

const TEMPLATE_COLUMNS = `
  id, zone_id, weekday, to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time,
  capacity, surcharge`;

const SLOT_COLUMNS = `id, zone_id, slot_date, starts_at, ends_at, capacity, booked, cutoff_at, surcharge`;

interface TemplateRow {
  id: string;
  zone_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  capacity: number;
  surcharge: string;
}

interface SlotRow {
  id: string;
  zone_id: string;
  slot_date: string;
  starts_at: Date;
  ends_at: Date;
  capacity: number;
  booked: number;
  cutoff_at: Date;
  surcharge: string;
}

const toTemplate = (r: TemplateRow): SlotTemplate => ({
  id: r.id,
  zoneId: r.zone_id,
  weekday: r.weekday,
  startTime: r.start_time,
  endTime: r.end_time,
  capacity: r.capacity,
  surcharge: r.surcharge,
});

const toSlot = (r: SlotRow): DeliverySlot => ({
  id: r.id,
  zoneId: r.zone_id,
  slotDate: r.slot_date,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  capacity: r.capacity,
  booked: r.booked,
  cutoffAt: r.cutoff_at,
  surcharge: r.surcharge,
});

@Injectable()
export class PgSlotRepository extends SlotRepository {
  async insertTemplate(q: Queryable, zoneId: string, t: SlotTemplateProps): Promise<SlotTemplate> {
    const { rows } = await q.query<TemplateRow>(
      `INSERT INTO logistics.delivery_slot_templates (zone_id, weekday, start_time, end_time, capacity, surcharge)
       VALUES ($1, $2, $3::time, $4::time, $5, $6)
       RETURNING ${TEMPLATE_COLUMNS}`,
      [zoneId, t.weekday, t.startTime, t.endTime, t.capacity, t.surcharge],
    );
    return toTemplate(rows[0]);
  }

  async updateTemplate(q: Queryable, zoneId: string, id: string, t: SlotTemplateProps): Promise<SlotTemplate | null> {
    const { rows } = await q.query<TemplateRow>(
      `UPDATE logistics.delivery_slot_templates
          SET weekday = $3, start_time = $4::time, end_time = $5::time, capacity = $6, surcharge = $7
        WHERE zone_id = $1 AND id = $2
        RETURNING ${TEMPLATE_COLUMNS}`,
      [zoneId, id, t.weekday, t.startTime, t.endTime, t.capacity, t.surcharge],
    );
    return rows[0] ? toTemplate(rows[0]) : null;
  }

  async findTemplate(q: Queryable, zoneId: string, id: string): Promise<SlotTemplate | null> {
    const { rows } = await q.query<TemplateRow>(
      `SELECT ${TEMPLATE_COLUMNS} FROM logistics.delivery_slot_templates WHERE zone_id = $1 AND id = $2`,
      [zoneId, id],
    );
    return rows[0] ? toTemplate(rows[0]) : null;
  }

  async deleteTemplate(q: Queryable, zoneId: string, id: string): Promise<boolean> {
    const { rowCount } = await q.query(`DELETE FROM logistics.delivery_slot_templates WHERE zone_id = $1 AND id = $2`, [zoneId, id]);
    return (rowCount ?? 0) > 0;
  }

  async listTemplates(q: Queryable, zoneId: string): Promise<SlotTemplate[]> {
    const { rows } = await q.query<TemplateRow>(
      `SELECT ${TEMPLATE_COLUMNS} FROM logistics.delivery_slot_templates WHERE zone_id = $1 ORDER BY weekday, start_time`,
      [zoneId],
    );
    return rows.map(toTemplate);
  }

  async insertSlots(q: Queryable, slots: NewDeliverySlot[]): Promise<number> {
    if (slots.length === 0) return 0;
    // Una sola sentencia con unnest; la UNIQUE (zone_id, starts_at) vuelve idempotente la generación.
    const { rowCount } = await q.query(
      `INSERT INTO logistics.delivery_slots (zone_id, slot_date, starts_at, ends_at, capacity, cutoff_at, surcharge)
       SELECT * FROM unnest($1::uuid[], $2::date[], $3::timestamptz[], $4::timestamptz[], $5::int[], $6::timestamptz[], $7::numeric[])
       ON CONFLICT (zone_id, starts_at) DO NOTHING`,
      [
        slots.map((s) => s.zoneId),
        slots.map((s) => s.slotDate),
        slots.map((s) => s.startsAt),
        slots.map((s) => s.endsAt),
        slots.map((s) => s.capacity),
        slots.map((s) => s.cutoffAt),
        slots.map((s) => s.surcharge),
      ],
    );
    return rowCount ?? 0;
  }

  async listSlots(q: Queryable, zoneId: string, fromDate: string, toDate: string): Promise<DeliverySlot[]> {
    const { rows } = await q.query<SlotRow>(
      `SELECT ${SLOT_COLUMNS} FROM logistics.delivery_slots
        WHERE zone_id = $1 AND slot_date BETWEEN $2::date AND $3::date
        ORDER BY starts_at`,
      [zoneId, fromDate, toDate],
    );
    return rows.map(toSlot);
  }

  async listBookable(q: Queryable, zoneId: string, now: Date, until: Date): Promise<DeliverySlot[]> {
    const { rows } = await q.query<SlotRow>(
      `SELECT ${SLOT_COLUMNS} FROM logistics.delivery_slots
        WHERE zone_id = $1 AND booked < capacity AND cutoff_at > $2 AND starts_at < $3
        ORDER BY starts_at`,
      [zoneId, now, until],
    );
    return rows.map(toSlot);
  }

  async findSlot(q: Queryable, zoneId: string, id: string): Promise<DeliverySlot | null> {
    const { rows } = await q.query<SlotRow>(`SELECT ${SLOT_COLUMNS} FROM logistics.delivery_slots WHERE zone_id = $1 AND id = $2`, [
      zoneId,
      id,
    ]);
    return rows[0] ? toSlot(rows[0]) : null;
  }

  async updateCapacity(q: Queryable, zoneId: string, id: string, capacity: number): Promise<DeliverySlot | null> {
    try {
      const { rows } = await q.query<SlotRow>(
        `UPDATE logistics.delivery_slots SET capacity = $3 WHERE zone_id = $1 AND id = $2 RETURNING ${SLOT_COLUMNS}`,
        [zoneId, id, capacity],
      );
      return rows[0] ? toSlot(rows[0]) : null;
    } catch (error) {
      // CHECK (booked <= capacity): la capacidad nueva quedó por debajo de lo ya reservado.
      if (error instanceof DatabaseError && error.code === '23514') {
        const slot = await this.findSlot(q, zoneId, id);
        throw new SlotCapacityBelowBookedError(slot?.booked ?? capacity + 1);
      }
      throw error;
    }
  }

  async book(q: Queryable, zoneId: string, id: string, now: Date): Promise<DeliverySlot | null> {
    // UPDATE condicional atómico (mismo patrón que la reserva de stock): dos checkouts por el
    // último cupo se serializan en el bloqueo de la fila; el segundo ve booked = capacity y no
    // actualiza nada.
    const { rows } = await q.query<SlotRow>(
      `UPDATE logistics.delivery_slots SET booked = booked + 1
        WHERE zone_id = $1 AND id = $2 AND booked < capacity AND cutoff_at > $3
        RETURNING ${SLOT_COLUMNS}`,
      [zoneId, id, now],
    );
    return rows[0] ? toSlot(rows[0]) : null;
  }

  async release(q: Queryable, id: string): Promise<boolean> {
    const { rowCount } = await q.query(`UPDATE logistics.delivery_slots SET booked = booked - 1 WHERE id = $1 AND booked > 0`, [id]);
    return (rowCount ?? 0) > 0;
  }
}
