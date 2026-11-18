/**
 * Módulo Soporte. support.tickets y support.ticket_messages ya existen en la migración 0001; esta
 * migración agrega a support.tickets (cambio aprobado el 2026-10-01):
 *
 *  - version: concurrencia optimista (dos agentes no se pisan al asignar o cambiar el estado).
 *  - updated_at: última actividad, para ordenar la cola.
 *  - sla_breached_at: cuándo se alertó el vencimiento del SLA. El job del worker solo alerta los
 *    tickets con esta columna en NULL, así la alerta sale una sola vez; también sirve para medir
 *    el cumplimiento del SLA en Reportes.
 *  - closed_at: inicio de la encuesta CSAT (el cierre automático usa resolved_at).
 *  - csat_comment / csat_at: comentario de la encuesta y cuándo se respondió (una sola vez).
 *  - source_ref: origen de un ticket creado por un evento (p. ej. 'invoice:<documentId>'). Con el
 *    índice único parcial, un evento repetido (entrega "al menos una vez" del outbox) no abre un
 *    segundo ticket.
 *
 * Índices: ix_tickets_sla_due (lo que el job revisa: abiertos sin alerta, por vencimiento),
 * ix_tickets_autoclose (resueltos por fecha) y ix_tickets_requester ("mis tickets").
 * Permisos: support.tickets.read, support.tickets.write y support.tickets.assign.
 */
const PERMISSIONS = [
  ['support.tickets.read', 'Consultar la cola de tickets de soporte, su detalle y las notas internas'],
  ['support.tickets.write', 'Atender tickets: responder al cliente, notas internas, estado, prioridad y categoría'],
  ['support.tickets.assign', 'Asignar tickets de soporte a otros agentes'],
];

exports.up = (pgm) => {
  const values = PERMISSIONS.map(([code, desc]) => `('${code}', '${desc.replace(/'/g, "''")}')`).join(',\n  ');
  pgm.sql(`
    ALTER TABLE support.tickets
      ADD COLUMN version int NOT NULL DEFAULT 1,
      ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN sla_breached_at timestamptz,
      ADD COLUMN closed_at timestamptz,
      ADD COLUMN csat_comment text,
      ADD COLUMN csat_at timestamptz,
      ADD COLUMN source_ref text,
      ADD CONSTRAINT ck_tickets_csat_closed CHECK (csat IS NULL OR closed_at IS NOT NULL);

    CREATE UNIQUE INDEX ux_tickets_source_ref ON support.tickets (tenant_id, source_ref) WHERE source_ref IS NOT NULL;
    CREATE INDEX ix_tickets_sla_due ON support.tickets (sla_due_at)
      WHERE status IN ('open', 'in_progress') AND sla_breached_at IS NULL;
    CREATE INDEX ix_tickets_autoclose ON support.tickets (resolved_at) WHERE status = 'resolved';
    CREATE INDEX ix_tickets_requester ON support.tickets (tenant_id, requester_id, created_at DESC);

    INSERT INTO iam.permissions (code, description) VALUES
      ${values}
    ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM iam.role_permissions WHERE permission_code IN (${PERMISSIONS.map(([c]) => `'${c}'`).join(', ')});
    DELETE FROM iam.permissions WHERE code IN (${PERMISSIONS.map(([c]) => `'${c}'`).join(', ')});
    DROP INDEX IF EXISTS support.ix_tickets_requester;
    DROP INDEX IF EXISTS support.ix_tickets_autoclose;
    DROP INDEX IF EXISTS support.ix_tickets_sla_due;
    DROP INDEX IF EXISTS support.ux_tickets_source_ref;
    ALTER TABLE support.tickets
      DROP CONSTRAINT IF EXISTS ck_tickets_csat_closed,
      DROP COLUMN IF EXISTS source_ref,
      DROP COLUMN IF EXISTS csat_at,
      DROP COLUMN IF EXISTS csat_comment,
      DROP COLUMN IF EXISTS closed_at,
      DROP COLUMN IF EXISTS sla_breached_at,
      DROP COLUMN IF EXISTS updated_at,
      DROP COLUMN IF EXISTS version;
  `);
};
