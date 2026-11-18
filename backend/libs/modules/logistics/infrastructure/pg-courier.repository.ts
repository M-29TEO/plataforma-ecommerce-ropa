import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Queryable } from '../../../shared-kernel';
import { CourierQuoteRecord, CourierRepository, CourierServiceInfo, NewCourierQuote } from '../application/ports';
import { RateCard } from '../domain/rate-card';

interface ServiceRow {
  courier_id: string;
  courier_code: string;
  courier_name: string;
  adapter: string;
  supports_cod: boolean;
  service_id: string;
  service_code: string;
  service_name: string;
  max_weight_kg: string | null;
  sla_hours: number | null;
}

interface RateCardRow {
  id: string;
  courier_service_id: string;
  origin_city: string;
  dest_province: string;
  dest_city: string | null;
  weight_from_kg: string;
  weight_to_kg: string;
  price: string;
  extra_kg_price: string;
  valid_from: string;
  valid_to: string | null;
}

interface QuoteRow {
  id: string;
  quote_group_id: string;
  shipment_id: string | null;
  courier_service_id: string;
  price: string;
  eta_hours: number | null;
  source: 'api' | 'rate_card';
  raw_response: unknown;
  selected: boolean;
  valid_until: Date;
}

@Injectable()
export class PgCourierRepository extends CourierRepository {
  async listActiveServices(q: Queryable, tenantId: string): Promise<CourierServiceInfo[]> {
    const { rows } = await q.query<ServiceRow>(
      `SELECT c.id AS courier_id, c.code AS courier_code, c.name AS courier_name, c.adapter, c.supports_cod,
              s.id AS service_id, s.code AS service_code, s.name AS service_name, s.max_weight_kg, s.sla_hours
         FROM logistics.couriers c
         JOIN logistics.courier_services s ON s.courier_id = c.id
        WHERE c.tenant_id = $1 AND c.active AND s.active
        ORDER BY c.code, s.code`,
      [tenantId],
    );
    return rows.map((r) => ({
      courierId: r.courier_id,
      courierCode: r.courier_code,
      courierName: r.courier_name,
      adapter: r.adapter,
      supportsCod: r.supports_cod,
      serviceId: r.service_id,
      serviceCode: r.service_code,
      serviceName: r.service_name,
      maxWeightKg: r.max_weight_kg === null ? null : Number(r.max_weight_kg),
      slaHours: r.sla_hours,
    }));
  }

  async listRateCards(q: Queryable, serviceIds: string[]): Promise<RateCard[]> {
    if (serviceIds.length === 0) return [];
    const { rows } = await q.query<RateCardRow>(
      `SELECT id::text, courier_service_id, origin_city, dest_province, dest_city, weight_from_kg, weight_to_kg,
              price, extra_kg_price, valid_from, valid_to
         FROM logistics.courier_rate_cards
        WHERE courier_service_id = ANY($1::uuid[])`,
      [serviceIds],
    );
    return rows.map((r) => ({
      id: r.id,
      courierServiceId: r.courier_service_id,
      originCity: r.origin_city,
      destProvince: r.dest_province,
      destCity: r.dest_city,
      weightFromKg: Number(r.weight_from_kg),
      weightToKg: Number(r.weight_to_kg),
      price: r.price,
      extraKgPrice: r.extra_kg_price,
      validFrom: r.valid_from,
      validTo: r.valid_to,
    }));
  }

  async insertQuotes(q: Queryable, quotes: NewCourierQuote[]): Promise<string[]> {
    if (quotes.length === 0) return [];
    const ids = quotes.map(() => randomUUID());
    await q.query(
      `INSERT INTO logistics.courier_quotes (id, quote_group_id, courier_service_id, price, eta_hours, source, raw_response, valid_until)
       SELECT * FROM unnest($8::uuid[], $1::uuid[], $2::uuid[], $3::numeric[], $4::int[], $5::text[], $6::jsonb[], $7::timestamptz[])`,
      [
        quotes.map((x) => x.quoteGroupId),
        quotes.map((x) => x.courierServiceId),
        quotes.map((x) => x.price),
        quotes.map((x) => x.etaHours),
        quotes.map((x) => x.source),
        quotes.map((x) => JSON.stringify(x.rawResponse ?? null)),
        quotes.map((x) => x.validUntil),
        ids,
      ],
    );
    return ids;
  }

  async findQuote(q: Queryable, tenantId: string, id: string): Promise<CourierQuoteRecord | null> {
    const { rows } = await q.query<QuoteRow>(
      `SELECT cq.id, cq.quote_group_id, cq.shipment_id, cq.courier_service_id, cq.price, cq.eta_hours, cq.source,
              cq.raw_response, cq.selected, cq.valid_until
         FROM logistics.courier_quotes cq
         JOIN logistics.courier_services s ON s.id = cq.courier_service_id
         JOIN logistics.couriers c ON c.id = s.courier_id
        WHERE cq.id = $2 AND c.tenant_id = $1`,
      [tenantId, id],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      quoteGroupId: r.quote_group_id,
      shipmentId: r.shipment_id,
      courierServiceId: r.courier_service_id,
      price: r.price,
      etaHours: r.eta_hours,
      source: r.source,
      rawResponse: r.raw_response,
      selected: r.selected,
      validUntil: r.valid_until,
    };
  }

  async markSelected(q: Queryable, id: string, shipmentId: string): Promise<boolean> {
    const { rowCount } = await q.query(
      `UPDATE logistics.courier_quotes SET selected = true, shipment_id = $2 WHERE id = $1 AND shipment_id IS NULL`,
      [id, shipmentId],
    );
    return (rowCount ?? 0) > 0;
  }
}
