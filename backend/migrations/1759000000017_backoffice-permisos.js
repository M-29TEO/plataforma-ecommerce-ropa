/**
 * Backoffice (2026-10-07). No cambia tablas ni columnas: solo agrega permisos a iam.permissions.
 * Qué roles los tienen lo sincroniza IAM al arrancar desde domain/system-roles.ts (incluido el rol
 * nuevo `logistics`, que se crea solo en cada tenant).
 *
 *  - iam.users.read / iam.users.write: pantalla de usuarios (listar, crear staff, bloquear).
 *  - inventory.picking: cola de picking de bodega con escaneo de códigos de barras.
 *  - orders.assisted.create: pedidos asistidos que el vendedor crea a nombre de un cliente
 *    (sales.orders.channel = 'backoffice' y seller_id, columnas que ya existían).
 */
const PERMISSIONS = [
  ['iam.users.read', 'Consultar usuarios del staff y clientes (sin datos de pago)'],
  ['iam.users.write', 'Crear usuarios del staff y bloquear o desbloquear cuentas'],
  ['inventory.picking', 'Preparar pedidos en bodega (picking con escaneo de códigos de barras)'],
  ['orders.assisted.create', 'Crear pedidos asistidos a nombre de un cliente desde el backoffice'],
];

exports.up = (pgm) => {
  const values = PERMISSIONS.map(([code, desc]) => `('${code}', '${desc.replace(/'/g, "''")}')`).join(',\n      ');
  pgm.sql(`
    INSERT INTO iam.permissions (code, description) VALUES
      ${values}
    ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description;
  `);
};

exports.down = (pgm) => {
  const codes = PERMISSIONS.map(([c]) => `'${c}'`).join(', ');
  pgm.sql(`
    DELETE FROM iam.user_roles WHERE role_id IN (SELECT id FROM iam.roles WHERE code = 'logistics' AND is_system);
    DELETE FROM iam.roles WHERE code = 'logistics' AND is_system;
    DELETE FROM iam.role_permissions WHERE permission_code IN (${codes});
    DELETE FROM iam.permissions WHERE code IN (${codes});
  `);
};
