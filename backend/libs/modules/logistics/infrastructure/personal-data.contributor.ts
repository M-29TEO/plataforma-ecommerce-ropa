import { Injectable, OnModuleInit } from '@nestjs/common';
import { AnonymizationResult, Database, DataSubject, PersonalDataContributor, PersonalDataRegistry } from '../../../shared-kernel';

/** Estados en los que el envío ya no se mueve (el CHECK de logistics.shipments; failed_attempt se reintenta). */
const FINAL_STATUSES = ['delivered', 'returned_to_origin', 'cancelled'];

/** Destinos que son una tienda o bodega (logística inversa): su dirección no es del titular. */
const STORE_DESTINATIONS = ['drop_off', 'store_pickup'];

interface ShipmentRow {
  id: string;
  order_id: string;
  direction: string;
  carrier_type: string;
  status: string;
  tracking_number: string | null;
  destination: Record<string, unknown>;
  eta: Date | null;
  assigned_at: Date | null;
  picked_up_at: Date | null;
  delivered_at: Date | null;
  created_at: Date;
}

interface RatingRow {
  shipment_id: string;
  score: number;
  tags: string[];
  comment: string | null;
  created_at: Date;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * LOPDP en Logística (schema logistics). Exporta los envíos de los pedidos del titular (destino
 * tal como se guardó, estados y fechas) y las calificaciones que él hizo a sus entregas. Nunca
 * exporta tracking_token, otp_hash ni label_key.
 *
 * Anonimiza, en los envíos de sus pedidos: destination queda solo con city, province y type (lo
 * que se usa para cotizar y mostrar; los reportes toman la ciudad de sales.orders, no de aquí);
 * destination_location y la ubicación de las pruebas de entrega se redondean a una grilla de 0.01°
 * (~1 km) para que las métricas por zona sigan valiendo sin señalar la casa; receiver_name de las
 * pruebas de entrega queda NULL; y el comentario de sus calificaciones, NULL (score y tags quedan
 * para el desempeño y la liquidación del motorizado). Los destinos que son una tienda
 * (drop_off/store_pickup) no se tocan. Se conserva el envío en sí (costos, COD, liquidaciones).
 *
 * Bloquea mientras haya un envío de sus pedidos sin terminar: la dirección todavía hace falta.
 */
@Injectable()
export class LogisticsPersonalDataContributor extends PersonalDataContributor implements OnModuleInit {
  readonly section = 'entregas';

  constructor(
    private readonly registry: PersonalDataRegistry,
    private readonly db: Database,
  ) {
    super();
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  async exportData(subject: DataSubject): Promise<unknown> {
    const shipments = subject.orderIds.length
      ? (
          await this.db.query<ShipmentRow>(
            `SELECT id, order_id, direction, carrier_type, status, tracking_number, destination,
                    eta, assigned_at, picked_up_at, delivered_at, created_at
               FROM logistics.shipments
              WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])
              ORDER BY created_at`,
            [subject.tenantId, subject.orderIds],
          )
        ).rows
      : [];
    // logistics.ratings no tiene tenant_id: se filtra por el envío.
    const { rows: ratings } = await this.db.query<RatingRow>(
      `SELECT r.shipment_id, r.score, r.tags, r.comment, r.created_at
         FROM logistics.ratings r JOIN logistics.shipments s ON s.id = r.shipment_id
        WHERE s.tenant_id = $1 AND r.rater_type = 'customer' AND r.rater_id = $2
        ORDER BY r.created_at`,
      [subject.tenantId, subject.userId],
    );
    return {
      shipments: shipments.map((s) => ({
        id: s.id,
        orderId: s.order_id,
        direction: s.direction,
        carrierType: s.carrier_type,
        status: s.status,
        trackingNumber: s.tracking_number,
        destination: s.destination,
        eta: iso(s.eta),
        assignedAt: iso(s.assigned_at),
        pickedUpAt: iso(s.picked_up_at),
        deliveredAt: iso(s.delivered_at),
        createdAt: s.created_at.toISOString(),
      })),
      ratings: ratings.map((r) => ({
        shipmentId: r.shipment_id,
        score: r.score,
        tags: r.tags,
        comment: r.comment,
        createdAt: r.created_at.toISOString(),
      })),
    };
  }

  override async blockers(subject: DataSubject): Promise<string[]> {
    if (subject.orderIds.length === 0) return [];
    const { rows } = await this.db.query<{ id: string; tracking_number: string | null }>(
      `SELECT id, tracking_number FROM logistics.shipments
        WHERE tenant_id = $1 AND order_id = ANY($2::uuid[]) AND status <> ALL($3::text[])
        ORDER BY created_at`,
      [subject.tenantId, subject.orderIds, FINAL_STATUSES],
    );
    return rows.map((r) => `Envío ${r.tracking_number ?? r.id} en curso`);
  }

  async anonymize(subject: DataSubject): Promise<AnonymizationResult> {
    let affected = 0;
    if (subject.orderIds.length > 0) {
      const shipments = await this.db.query(
        `UPDATE logistics.shipments
            SET destination = jsonb_strip_nulls(jsonb_build_object(
                  'city', destination->'city', 'province', destination->'province', 'type', destination->'type')),
                destination_location = ST_SnapToGrid(destination_location::geometry, 0.01)::geography,
                updated_at = now(), version = version + 1
          WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])
            AND COALESCE(destination->>'type', '') <> ALL($3::text[])`,
        [subject.tenantId, subject.orderIds, STORE_DESTINATIONS],
      );
      const proofs = await this.db.query(
        `UPDATE logistics.delivery_proofs p
            SET receiver_name = NULL, location = ST_SnapToGrid(p.location::geometry, 0.01)::geography
           FROM logistics.shipments s
          WHERE s.id = p.shipment_id AND s.tenant_id = $1 AND s.order_id = ANY($2::uuid[])`,
        [subject.tenantId, subject.orderIds],
      );
      affected += (shipments.rowCount ?? 0) + (proofs.rowCount ?? 0);
    }
    const ratings = await this.db.query(
      `UPDATE logistics.ratings r SET comment = NULL
         FROM logistics.shipments s
        WHERE s.id = r.shipment_id AND s.tenant_id = $1 AND r.rater_type = 'customer' AND r.rater_id = $2
          AND r.comment IS NOT NULL`,
      [subject.tenantId, subject.userId],
    );
    affected += ratings.rowCount ?? 0;
    return {
      affected,
      retained: [
        'Envíos de tus pedidos (ciudad, provincia, fechas, costos y cobro contra entrega): sustentan la facturación y la liquidación de los motorizados',
      ],
    };
  }
}
