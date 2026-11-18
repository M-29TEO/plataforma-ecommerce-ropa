/**
 * Módulo Reportes (schema reports). Es el único módulo que lee varios schemas a la vez: las
 * vistas materializadas cruzan sales, logistics, catalog e iam para que el dashboard del gerente
 * no consulte las tablas transaccionales. El worker las refresca con REFRESH ... CONCURRENTLY
 * cada 15 minutos (no bloquea a quien las lee); por eso cada vista tiene un índice único.
 *
 * Días en America/Guayaquil. "Venta" = pedido no cancelado y pagado, o contra entrega (que se
 * cobra al entregar). Montos netos = sin IVA (line_total - tax_amount) y descontando las unidades
 * devueltas (qty_returned); margen = neto - costo, solo con las líneas que tienen unit_cost.
 *
 *  - mv_sales_daily: grano pedido (dimensiones de un solo valor por pedido: ciudad, barrio, método
 *    de pago, tipo de entrega, canal, courier, motorizado). Pedidos y ticket promedio son sumables.
 *    Barrio = shipping_address.neighborhood; si falta, la zona de cobertura; si no, 'Sin barrio'.
 *  - mv_sales_items_daily: grano línea (categoría, talla, color, producto). Unidades y montos.
 *  - mv_delivery_performance: envíos de salida por día de creación, tipo, courier, motorizado y
 *    zona. Tiempos en minutos desde el pago (desde la compra si es contra entrega) hasta la
 *    entrega, en sumas y tramos para poder reagrupar por semana o mes; a tiempo = entregado antes
 *    del fin de la franja, del ETA o del SLA del servicio de courier.
 *  - mv_funnel_daily: carritos (creados, con productos, convertidos, abandonados, recordados) y
 *    pedidos (creados, ventas). Abandonado = activo con productos y 1 h o más sin actividad (la
 *    primera etapa de recordatorio).
 *
 * Tablas: reports.export_jobs (exportes Excel/PDF asíncronos; el archivo queda en SeaweedFS) y
 * reports.refresh_log (cuándo se refrescó cada vista, para mostrar "datos al ...").
 * Permisos: reports.sales.read, reports.delivery.read, reports.funnel.read y reports.export.
 */
const PERMISSIONS = [
  ['reports.sales.read', 'Consultar reportes de ventas, ticket promedio y margen'],
  ['reports.delivery.read', 'Consultar tiempos de entrega y cumplimiento por courier y motorizado'],
  ['reports.funnel.read', 'Consultar conversión y carritos abandonados'],
  ['reports.export', 'Exportar reportes a Excel o PDF'],
];

const SALE = `o.status <> 'cancelled' AND (o.paid_at IS NOT NULL OR o.payment_method = 'cod')`;

exports.up = (pgm) => {
  const values = PERMISSIONS.map(([code, desc]) => `('${code}', '${desc.replace(/'/g, "''")}')`).join(',\n  ');
  pgm.sql(`
    CREATE SCHEMA reports;

    CREATE MATERIALIZED VIEW reports.mv_sales_daily AS
    SELECT o.tenant_id,
           (o.placed_at AT TIME ZONE 'America/Guayaquil')::date AS day,
           COALESCE(NULLIF(o.shipping_city, ''), 'Sin ciudad') AS city,
           COALESCE(NULLIF(o.shipping_address->>'neighborhood', ''), z.name, 'Sin barrio') AS neighborhood,
           o.payment_method,
           o.fulfillment_type,
           o.channel,
           COALESCE(c.id::text, '') AS courier_key,
           COALESCE(c.name, 'Sin courier') AS courier_name,
           COALESCE(sh.rider_id::text, '') AS rider_key,
           COALESCE(NULLIF(trim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email::text, 'Sin motorizado') AS rider_name,
           count(*)::int AS orders,
           sum(i.units)::int AS units,
           sum(i.units_returned)::int AS units_returned,
           sum(o.total) AS gross_sales,
           sum(o.discount_total) AS discounts,
           sum(o.shipping_total) AS shipping,
           sum(o.tax_total) AS tax,
           sum(i.net_sales) AS net_sales,
           sum(i.returns_net) AS returns_net,
           sum(i.cost) AS cost,
           sum(i.net_sales_costed) AS net_sales_costed
      FROM sales.orders o
      CROSS JOIN LATERAL (
        SELECT COALESCE(sum(oi.quantity), 0) AS units,
               COALESCE(sum(oi.qty_returned), 0) AS units_returned,
               COALESCE(sum(round((oi.line_total - oi.tax_amount) * (oi.quantity - oi.qty_returned) / oi.quantity, 2)), 0) AS net_sales,
               COALESCE(sum(round((oi.line_total - oi.tax_amount) * oi.qty_returned / oi.quantity, 2)), 0) AS returns_net,
               COALESCE(sum(oi.unit_cost * (oi.quantity - oi.qty_returned)), 0) AS cost,
               COALESCE(sum(round((oi.line_total - oi.tax_amount) * (oi.quantity - oi.qty_returned) / oi.quantity, 2))
                          FILTER (WHERE oi.unit_cost IS NOT NULL), 0) AS net_sales_costed
          FROM sales.order_items oi
         WHERE oi.order_id = o.id
      ) i
      LEFT JOIN LATERAL (
        SELECT s.rider_id, s.courier_service_id
          FROM logistics.shipments s
         WHERE s.order_id = o.id AND s.direction = 'outbound' AND s.status <> 'cancelled'
         ORDER BY s.created_at DESC
         LIMIT 1
      ) sh ON true
      LEFT JOIN logistics.courier_services cs ON cs.id = sh.courier_service_id
      LEFT JOIN logistics.couriers c ON c.id = cs.courier_id
      LEFT JOIN logistics.riders r ON r.id = sh.rider_id
      LEFT JOIN iam.users u ON u.id = r.user_id
      LEFT JOIN logistics.coverage_zones z ON z.id = o.shipping_zone_id
     WHERE ${SALE}
     GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11;

    CREATE UNIQUE INDEX ux_mv_sales_daily ON reports.mv_sales_daily
      (tenant_id, day, city, neighborhood, payment_method, fulfillment_type, channel, courier_key, rider_key);

    CREATE MATERIALIZED VIEW reports.mv_sales_items_daily AS
    SELECT o.tenant_id,
           (o.placed_at AT TIME ZONE 'America/Guayaquil')::date AS day,
           COALESCE(NULLIF(oi.category_path, ''), 'Sin categoría') AS category,
           COALESCE(NULLIF(oi.size_code, ''), 'Sin talla') AS size,
           COALESCE(NULLIF(oi.color_name, ''), 'Sin color') AS color,
           oi.product_id,
           max(oi.product_name) AS product_name,
           sum(oi.quantity)::int AS units,
           sum(oi.qty_returned)::int AS units_returned,
           sum(round((oi.line_total - oi.tax_amount) * (oi.quantity - oi.qty_returned) / oi.quantity, 2)) AS net_sales,
           sum(round((oi.line_total - oi.tax_amount) * oi.qty_returned / oi.quantity, 2)) AS returns_net,
           COALESCE(sum(oi.unit_cost * (oi.quantity - oi.qty_returned)), 0) AS cost,
           COALESCE(sum(round((oi.line_total - oi.tax_amount) * (oi.quantity - oi.qty_returned) / oi.quantity, 2))
                      FILTER (WHERE oi.unit_cost IS NOT NULL), 0) AS net_sales_costed
      FROM sales.order_items oi
      JOIN sales.orders o ON o.id = oi.order_id
     WHERE ${SALE}
     GROUP BY 1, 2, 3, 4, 5, 6;

    CREATE UNIQUE INDEX ux_mv_sales_items_daily ON reports.mv_sales_items_daily
      (tenant_id, day, category, size, color, product_id);

    CREATE MATERIALIZED VIEW reports.mv_delivery_performance AS
    WITH base AS (
      SELECT s.tenant_id,
             (s.created_at AT TIME ZONE 'America/Guayaquil')::date AS day,
             s.carrier_type,
             COALESCE(c.id::text, '') AS courier_key,
             COALESCE(c.name, 'Sin courier') AS courier_name,
             COALESCE(s.rider_id::text, '') AS rider_key,
             COALESCE(NULLIF(trim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email::text, 'Sin motorizado') AS rider_name,
             COALESCE(z.id::text, '') AS zone_key,
             COALESCE(z.name, 'Sin zona') AS zone_name,
             s.status,
             s.attempts,
             CASE WHEN s.status = 'delivered' AND s.delivered_at IS NOT NULL THEN extract(epoch FROM s.delivered_at - st.start_at) / 60
             END AS lead_min,
             CASE WHEN s.status = 'delivered' AND s.delivered_at IS NOT NULL AND s.picked_up_at IS NOT NULL THEN
               extract(epoch FROM s.delivered_at - s.picked_up_at) / 60
             END AS transit_min,
             COALESCE(ds.ends_at, s.eta,
                      CASE WHEN cs.sla_hours IS NOT NULL THEN
                        st.start_at + make_interval(hours => cs.sla_hours) END) AS promised_at,
             s.delivered_at,
             rt.score
        FROM logistics.shipments s
        JOIN sales.orders o ON o.id = s.order_id
        -- Inicio del reloj: el pago; contra entrega, la compra (su paid_at se fija al entregar).
        CROSS JOIN LATERAL (SELECT CASE WHEN o.payment_method = 'cod' THEN o.placed_at ELSE COALESCE(o.paid_at, o.placed_at) END AS start_at) st
        LEFT JOIN logistics.courier_services cs ON cs.id = s.courier_service_id
        LEFT JOIN logistics.couriers c ON c.id = cs.courier_id
        LEFT JOIN logistics.riders r ON r.id = s.rider_id
        LEFT JOIN iam.users u ON u.id = r.user_id
        LEFT JOIN logistics.coverage_zones z ON z.id = s.zone_id
        LEFT JOIN logistics.delivery_slots ds ON ds.id = s.delivery_slot_id
        LEFT JOIN logistics.ratings rt ON rt.shipment_id = s.id AND rt.rater_type = 'customer'
       WHERE s.direction = 'outbound'
    )
    SELECT tenant_id, day, carrier_type, courier_key, courier_name, rider_key, rider_name, zone_key, zone_name,
           count(*)::int AS shipments,
           count(*) FILTER (WHERE status = 'delivered')::int AS delivered,
           count(*) FILTER (WHERE status IN ('failed_attempt', 'returned_to_origin'))::int AS failed,
           count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
           COALESCE(sum(attempts), 0)::int AS attempts,
           count(lead_min)::int AS lead_count,
           COALESCE(sum(lead_min), 0)::numeric(14,2) AS lead_min_sum,
           count(transit_min)::int AS transit_count,
           COALESCE(sum(transit_min), 0)::numeric(14,2) AS transit_min_sum,
           count(*) FILTER (WHERE lead_min <= 120)::int AS within_2h,
           count(*) FILTER (WHERE lead_min > 120 AND lead_min <= 1440)::int AS within_24h,
           count(*) FILTER (WHERE lead_min > 1440 AND lead_min <= 2880)::int AS within_48h,
           count(*) FILTER (WHERE lead_min > 2880 AND lead_min <= 4320)::int AS within_72h,
           count(*) FILTER (WHERE lead_min > 4320)::int AS over_72h,
           count(*) FILTER (WHERE lead_min IS NOT NULL AND promised_at IS NOT NULL)::int AS with_promise,
           count(*) FILTER (WHERE lead_min IS NOT NULL AND promised_at IS NOT NULL AND delivered_at <= promised_at)::int AS on_time,
           count(score)::int AS rating_count,
           COALESCE(sum(score), 0)::int AS rating_sum
      FROM base
     GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9;

    CREATE UNIQUE INDEX ux_mv_delivery_performance ON reports.mv_delivery_performance
      (tenant_id, day, carrier_type, courier_key, rider_key, zone_key);

    CREATE MATERIALIZED VIEW reports.mv_funnel_daily AS
    WITH carts AS (
      SELECT c.tenant_id,
             (c.created_at AT TIME ZONE 'America/Guayaquil')::date AS day,
             count(*)::int AS carts_created,
             count(*) FILTER (WHERE it.items > 0 OR c.status = 'converted')::int AS carts_with_items,
             count(*) FILTER (WHERE c.status = 'converted')::int AS carts_converted,
             count(*) FILTER (WHERE c.status = 'abandoned'
                                 OR (c.status = 'active' AND it.items > 0 AND c.last_activity_at < now() - interval '1 hour'))::int
               AS carts_abandoned,
             count(*) FILTER (WHERE c.reminders_sent > 0)::int AS carts_reminded,
             COALESCE(sum(it.value) FILTER (WHERE c.status = 'abandoned'
                                 OR (c.status = 'active' AND it.items > 0 AND c.last_activity_at < now() - interval '1 hour')), 0)
               AS abandoned_value
        FROM sales.carts c
        CROSS JOIN LATERAL (
          SELECT count(*) AS items, COALESCE(sum(ci.quantity * ci.price_at_add), 0) AS value
            FROM sales.cart_items ci WHERE ci.cart_id = c.id
        ) it
       WHERE c.status <> 'merged'
       GROUP BY 1, 2
    ), orders AS (
      SELECT o.tenant_id,
             (o.placed_at AT TIME ZONE 'America/Guayaquil')::date AS day,
             count(*)::int AS orders_placed,
             count(*) FILTER (WHERE ${SALE})::int AS orders_paid,
             COALESCE(sum(o.total) FILTER (WHERE ${SALE}), 0) AS revenue
        FROM sales.orders o
       GROUP BY 1, 2
    )
    SELECT COALESCE(c.tenant_id, o.tenant_id) AS tenant_id,
           COALESCE(c.day, o.day) AS day,
           COALESCE(c.carts_created, 0) AS carts_created,
           COALESCE(c.carts_with_items, 0) AS carts_with_items,
           COALESCE(c.carts_converted, 0) AS carts_converted,
           COALESCE(c.carts_abandoned, 0) AS carts_abandoned,
           COALESCE(c.carts_reminded, 0) AS carts_reminded,
           COALESCE(c.abandoned_value, 0) AS abandoned_value,
           COALESCE(o.orders_placed, 0) AS orders_placed,
           COALESCE(o.orders_paid, 0) AS orders_paid,
           COALESCE(o.revenue, 0) AS revenue
      FROM carts c
      FULL JOIN orders o ON o.tenant_id = c.tenant_id AND o.day = c.day;

    CREATE UNIQUE INDEX ux_mv_funnel_daily ON reports.mv_funnel_daily (tenant_id, day);

    CREATE TABLE reports.refresh_log (
      view_name    text PRIMARY KEY,
      refreshed_at timestamptz NOT NULL,
      duration_ms  int NOT NULL
    );
    INSERT INTO reports.refresh_log (view_name, refreshed_at, duration_ms) VALUES
      ('mv_sales_daily', now(), 0), ('mv_sales_items_daily', now(), 0),
      ('mv_delivery_performance', now(), 0), ('mv_funnel_daily', now(), 0);

    CREATE TABLE reports.export_jobs (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id    uuid NOT NULL REFERENCES iam.tenants(id),
      requested_by uuid NOT NULL REFERENCES iam.users(id),
      report       text NOT NULL CHECK (report IN ('sales', 'sales_items', 'delivery', 'funnel')),
      format       text NOT NULL CHECK (format IN ('xlsx', 'pdf')),
      params       jsonb NOT NULL,
      status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
      attempts     smallint NOT NULL DEFAULT 0,
      storage_key  text,
      filename     text,
      size_bytes   int,
      row_count    int,
      error        text,
      created_at   timestamptz NOT NULL DEFAULT now(),
      started_at   timestamptz,
      finished_at  timestamptz,
      expires_at   timestamptz,
      CHECK (status <> 'done' OR storage_key IS NOT NULL)
    );
    CREATE INDEX ix_export_jobs_pending ON reports.export_jobs (created_at) WHERE status IN ('queued', 'running');
    CREATE INDEX ix_export_jobs_requester ON reports.export_jobs (tenant_id, requested_by, created_at DESC);

    INSERT INTO iam.permissions (code, description) VALUES
      ${values}
    ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM iam.role_permissions WHERE permission_code IN (${PERMISSIONS.map(([c]) => `'${c}'`).join(', ')});
    DELETE FROM iam.permissions WHERE code IN (${PERMISSIONS.map(([c]) => `'${c}'`).join(', ')});
    DROP SCHEMA reports CASCADE;
  `);
};
