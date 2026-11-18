/**
 * Módulo Logística (cotización):
 *  1. Catálogo de permisos del módulo (iam.permissions).
 *  2. CHECK en logistics.delivery_slot_templates: end_time > start_time y capacity >= 0.
 *     Justificación: las franjas (delivery_slots) se generan desde estas plantillas; una plantilla
 *     con la hora de fin antes del inicio o con capacidad negativa produciría franjas imposibles
 *     (delivery_slots ya tiene CHECK (booked <= capacity), que fallaría recién al reservar).
 *     El dominio las valida; el CHECK es la última defensa ante SQL manual. No cambia columnas.
 *
 * El resto ya existe en la migración 0001 con los índices que se usan:
 *   - ix_zones_area (GiST) para ST_Covers(area, punto) al resolver la zona,
 *   - UNIQUE (zone_id, starts_at) en delivery_slots (generación idempotente de franjas),
 *   - CHECK (booked <= capacity) en delivery_slots (reserva de cupo con UPDATE condicional),
 *   - ix_rate_lookup en courier_rate_cards e ix_quotes_group en courier_quotes.
 */
const PERMISSIONS = [
  ['logistics.read', 'Consultar zonas de cobertura, franjas, couriers y cotizaciones de envío'],
  ['logistics.zone.write', 'Crear, editar y desactivar zonas de cobertura, plantillas de franjas y cupos'],
];

exports.up = (pgm) => {
  const values = PERMISSIONS.map(([code, desc]) => `('${code}', '${desc.replace(/'/g, "''")}')`).join(',\n  ');
  pgm.sql(`
    INSERT INTO iam.permissions (code, description) VALUES
      ${values}
    ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description;

    ALTER TABLE logistics.delivery_slot_templates
      ADD CONSTRAINT ck_slot_tpl_time_order CHECK (end_time > start_time),
      ADD CONSTRAINT ck_slot_tpl_capacity CHECK (capacity >= 0);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE logistics.delivery_slot_templates
      DROP CONSTRAINT IF EXISTS ck_slot_tpl_time_order,
      DROP CONSTRAINT IF EXISTS ck_slot_tpl_capacity;
    DELETE FROM iam.permissions WHERE code IN (${PERMISSIONS.map(([c]) => `'${c}'`).join(', ')});
  `);
};
