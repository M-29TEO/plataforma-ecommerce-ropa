/**
 * Devoluciones, cambios, reembolsos y notas de crédito. NO cambia tablas ni columnas: sales.returns,
 * sales.return_items, payments.refunds, logistics.shipments (return_id, direction) y
 * billing.electronic_documents (return_id, modified_document_id) ya existen en la migración 0001.
 *
 *  1. Permisos: returns.read, returns.approve (aprobar o rechazar solicitudes), returns.inspect
 *     (recepción e inspección en bodega), payments.refund.approve (aprobar reembolsos; por encima
 *     del umbral hacen falta dos personas) y payments.refund.complete (registrar la transferencia).
 *  2. Índices únicos (idempotencia garantizada en la base, además de la del código):
 *     - ux_refunds_return: un reembolso por devolución.
 *     - ux_ship_return_direction: un envío vigente (no cancelado) por devolución y dirección
 *       (un retiro 'return' y un envío 'exchange').
 *     - ux_ed_return_credit_note: una nota de crédito vigente por devolución (igual criterio que
 *       ux_ed_order_invoice: una anulada o NO AUTORIZADA no cuenta).
 *  3. Índices de consulta: return_items por devolución y por línea del pedido (unidades en
 *     solicitudes abiertas), reembolsos por pago y notas de crédito por factura modificada.
 *  4. CHECK (última defensa ante SQL manual; el dominio ya lo garantiza):
 *     - order_items: 0 <= qty_returned <= quantity.
 *     - returns.refund_amount >= 0.
 *  5. Secuencial de notas de crédito (04) en 0 para los puntos de emisión existentes.
 */
const PERMISSIONS = [
  ['returns.read', 'Consultar devoluciones y cambios, sus fotos, retiro y reembolso'],
  ['returns.approve', 'Aprobar o rechazar solicitudes de devolución y cambio'],
  ['returns.inspect', 'Registrar la recepción e inspección de devoluciones en bodega'],
  ['payments.refund.approve', 'Aprobar reembolsos (por encima del umbral exigen dos aprobaciones distintas)'],
  ['payments.refund.complete', 'Registrar la transferencia bancaria de un reembolso'],
];

exports.up = (pgm) => {
  const values = PERMISSIONS.map(([code, desc]) => `('${code}', '${desc.replace(/'/g, "''")}')`).join(',\n  ');
  pgm.sql(`
    INSERT INTO iam.permissions (code, description) VALUES
      ${values}
    ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description;

    CREATE UNIQUE INDEX ux_refunds_return ON payments.refunds (return_id) WHERE return_id IS NOT NULL;
    CREATE UNIQUE INDEX ux_ship_return_direction ON logistics.shipments (return_id, direction)
      WHERE return_id IS NOT NULL AND status <> 'cancelled';
    CREATE UNIQUE INDEX ux_ed_return_credit_note ON billing.electronic_documents (return_id)
      WHERE doc_type = '04' AND status NOT IN ('voided', 'not_authorized');

    CREATE INDEX ix_return_items_return ON sales.return_items (return_id);
    CREATE INDEX ix_return_items_order_item ON sales.return_items (order_item_id);
    CREATE INDEX ix_refunds_payment ON payments.refunds (payment_id);
    CREATE INDEX ix_ed_modified ON billing.electronic_documents (modified_document_id) WHERE modified_document_id IS NOT NULL;

    ALTER TABLE sales.order_items
      ADD CONSTRAINT ck_oi_qty_returned CHECK (qty_returned >= 0 AND qty_returned <= quantity);
    ALTER TABLE sales.returns
      ADD CONSTRAINT ck_returns_refund_amount CHECK (refund_amount IS NULL OR refund_amount >= 0);

    INSERT INTO billing.sequences (emission_point_id, doc_type, last_value)
    SELECT id, '04', 0 FROM billing.emission_points
    ON CONFLICT (emission_point_id, doc_type) DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE sales.returns DROP CONSTRAINT IF EXISTS ck_returns_refund_amount;
    ALTER TABLE sales.order_items DROP CONSTRAINT IF EXISTS ck_oi_qty_returned;
    DROP INDEX IF EXISTS billing.ix_ed_modified;
    DROP INDEX IF EXISTS payments.ix_refunds_payment;
    DROP INDEX IF EXISTS sales.ix_return_items_order_item;
    DROP INDEX IF EXISTS sales.ix_return_items_return;
    DROP INDEX IF EXISTS billing.ux_ed_return_credit_note;
    DROP INDEX IF EXISTS logistics.ux_ship_return_direction;
    DROP INDEX IF EXISTS payments.ux_refunds_return;
    DELETE FROM iam.permissions WHERE code IN (${PERMISSIONS.map(([c]) => `'${c}'`).join(', ')});
  `);
};
