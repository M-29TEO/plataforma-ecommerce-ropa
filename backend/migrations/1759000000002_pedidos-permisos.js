/**
 * Módulo Pedidos: catálogo de permisos (iam.permissions). No cambia tablas ni columnas;
 * sales.orders, sales.order_items y sales.order_status_history ya existen en la migración 0001.
 */
const PERMISSIONS = [
  ['orders.read', 'Consultar, filtrar y ver el historial de los pedidos'],
  ['orders.status.update', 'Avanzar el estado del pedido (preparación, despacho, en camino, entrega, devolución)'],
  ['orders.cancel', 'Cancelar pedidos'],
  ['orders.payment.confirm', 'Marcar un pedido como pagado manualmente (transferencia verificada)'],
];

exports.up = (pgm) => {
  const values = PERMISSIONS.map(([code, desc]) => `('${code}', '${desc.replace(/'/g, "''")}')`).join(',\n  ');
  pgm.sql(`
    INSERT INTO iam.permissions (code, description) VALUES
      ${values}
    ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM iam.permissions WHERE code IN (${PERMISSIONS.map(([c]) => `'${c}'`).join(', ')});`);
};
