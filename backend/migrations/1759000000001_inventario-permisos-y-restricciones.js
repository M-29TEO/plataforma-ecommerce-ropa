/**
 * Módulo Inventario:
 *  1. Catálogo de permisos del módulo (iam.permissions).
 *  2. CHECK qty_received <= qty_ordered en purchase_order_items.
 *     Justificación: el dominio ya impide recibir más de lo pedido; el CHECK es la última
 *     defensa ante bugs o SQL manual (mismo criterio que CHECK (reserved <= on_hand)).
 *     Recibir de más se registra como recepción adicional o ajuste, no inflando la orden.
 */
const PERMISSIONS = [
  ['inventory.read', 'Consultar bodegas, stock, movimientos, proveedores y órdenes de compra'],
  ['inventory.warehouse.write', 'Crear, editar y desactivar bodegas'],
  ['inventory.stock.write', 'Configurar punto de reorden, cantidad de reposición y ubicación'],
  ['inventory.adjust', 'Ajustes manuales de stock (ajuste, daño, conteo físico)'],
  ['inventory.supplier.write', 'Crear, editar y desactivar proveedores'],
  ['inventory.purchase.write', 'Crear, enviar y cancelar órdenes de compra'],
  ['inventory.purchase.receive', 'Registrar recepciones de órdenes de compra'],
];

exports.up = (pgm) => {
  const values = PERMISSIONS.map(([code, desc]) => `('${code}', '${desc.replace(/'/g, "''")}')`).join(',\n  ');
  pgm.sql(`
    INSERT INTO iam.permissions (code, description) VALUES
      ${values}
    ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description;

    ALTER TABLE inventory.purchase_order_items
      ADD CONSTRAINT ck_poi_received_le_ordered
      CHECK (qty_received >= 0 AND qty_received <= qty_ordered);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE inventory.purchase_order_items DROP CONSTRAINT IF EXISTS ck_poi_received_le_ordered;
    DELETE FROM iam.permissions WHERE code IN (${PERMISSIONS.map(([c]) => `'${c}'`).join(', ')});
  `);
};
