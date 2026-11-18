/**
 * Módulo Facturación SRI. No cambia tablas ni columnas: billing.emission_points, sequences,
 * electronic_documents y electronic_document_lines ya existen en la migración 0001.
 *
 * Agrega:
 *   - ux_ed_order_invoice: UNA factura por pedido. El consumidor de OrderPaid es idempotente, pero
 *     dos workers pueden procesar el mismo evento a la vez (entrega "al menos una vez"); el índice
 *     es la garantía en la base. Excluye las anuladas y las NO AUTORIZADAS: esa clave de acceso ya
 *     no se puede reutilizar, así que el pedido necesita una factura nueva con otro secuencial.
 *   - Permiso billing.read (backoffice: comprobantes, estado ante el SRI, XML y RIDE).
 *
 * Índices existentes que usa el módulo: ix_ed_retry (job de comprobantes pendientes), ix_ed_order,
 * UNIQUE (emission_point_id, doc_type, sequential) y UNIQUE (access_key).
 */
const PERMISSIONS = [['billing.read', 'Consultar comprobantes electrónicos, su estado ante el SRI, el XML y el RIDE']];

exports.up = (pgm) => {
  pgm.sql(`
    CREATE UNIQUE INDEX ux_ed_order_invoice ON billing.electronic_documents (order_id)
      WHERE doc_type = '01' AND status NOT IN ('voided', 'not_authorized');
  `);
  const values = PERMISSIONS.map(([code, desc]) => `('${code}', '${desc.replace(/'/g, "''")}')`).join(',\n  ');
  pgm.sql(`
    INSERT INTO iam.permissions (code, description) VALUES
      ${values}
    ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM iam.permissions WHERE code IN (${PERMISSIONS.map(([c]) => `'${c}'`).join(', ')});`);
  pgm.sql('DROP INDEX IF EXISTS billing.ux_ed_order_invoice;');
};
