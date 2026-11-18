/**
 * Módulo Notificaciones. platform.notification_templates, platform.notifications y
 * platform.push_subscriptions ya existen en la migración 0001; esta migración solo agrega:
 *
 *  1. Columnas de reintento en platform.notifications (cambio aprobado el 2026-09-30):
 *     - attempts: envíos fallidos. Tras NOTIFICATION_MAX_ATTEMPTS la notificación queda 'failed'.
 *     - next_attempt_at: cuándo toca (re)intentar. El despachador también la usa como "préstamo"
 *       (lease) para que dos réplicas del worker no envíen la misma fila. NULL en estados finales.
 *     Por qué columnas y no payload jsonb: el despachador filtra por ellas en cada pasada (con
 *     índice), y payload guarda el contenido del mensaje, no el estado del envío.
 *  2. ix_notif_due: índice parcial de lo que está en cola, por fecha de próximo intento.
 *  3. Permisos: notifications.read (bandeja de envíos del backoffice) y notifications.templates.write
 *     (editar las plantillas del tenant).
 */
const PERMISSIONS = [
  ['notifications.read', 'Consultar las notificaciones enviadas, suprimidas o fallidas y las plantillas'],
  ['notifications.templates.write', 'Editar las plantillas de notificación del tenant por canal e idioma'],
];

exports.up = (pgm) => {
  const values = PERMISSIONS.map(([code, desc]) => `('${code}', '${desc.replace(/'/g, "''")}')`).join(',\n  ');
  pgm.sql(`
    ALTER TABLE platform.notifications
      ADD COLUMN attempts smallint NOT NULL DEFAULT 0,
      ADD COLUMN next_attempt_at timestamptz DEFAULT now();

    UPDATE platform.notifications SET next_attempt_at = NULL WHERE status <> 'queued';

    CREATE INDEX ix_notif_due ON platform.notifications (next_attempt_at) WHERE status = 'queued';

    INSERT INTO iam.permissions (code, description) VALUES
      ${values}
    ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM iam.permissions WHERE code IN (${PERMISSIONS.map(([c]) => `'${c}'`).join(', ')});
    DROP INDEX IF EXISTS platform.ix_notif_due;
    ALTER TABLE platform.notifications DROP COLUMN IF EXISTS next_attempt_at, DROP COLUMN IF EXISTS attempts;
  `);
};
