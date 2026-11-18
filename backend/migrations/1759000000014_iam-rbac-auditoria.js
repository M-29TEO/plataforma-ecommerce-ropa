/**
 * IAM: RBAC y auditoría. No cambia tablas ni columnas.
 *
 *  1. Permisos nuevos (iam.permissions): gestión de roles, reset de 2FA y escritura del catálogo
 *     (catalog.product.write queda listo para el CRUD de productos, que aún no existe).
 *     Los roles del sistema (admin, manager, seller, warehouse, rider, support, customer) y sus
 *     permisos NO van aquí: son por tenant y los sincroniza IAM desde domain/system-roles.ts.
 *  2. platform.audit_log solo tenía la partición de 2026-10 (0001): desde el 1 de noviembre todo
 *     INSERT fallaría ("no partition of relation found"). La función
 *     platform.ensure_audit_log_partitions(desde, meses) crea las particiones mensuales que falten
 *     (idempotente); aquí se crean hasta 2027-12 y el job mensual del worker mantiene 3 meses por delante.
 */
const PERMISSIONS = [
  ['iam.roles.read', 'Ver los roles del tenant y los roles de cada usuario'],
  ['iam.roles.assign', 'Asignar y quitar roles a usuarios (queda en la auditoría)'],
  ['iam.mfa.reset', 'Resetear el 2FA de otro usuario que perdió su dispositivo (queda en la auditoría)'],
  ['catalog.product.write', 'Crear, editar y publicar productos del catálogo'],
];

exports.up = (pgm) => {
  const values = PERMISSIONS.map(([code, desc]) => `('${code}', '${desc.replace(/'/g, "''")}')`).join(',\n  ');
  pgm.sql(`
    INSERT INTO iam.permissions (code, description) VALUES
  ${values}
    ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description;

    CREATE FUNCTION platform.ensure_audit_log_partitions(p_from date, p_months int) RETURNS int
    LANGUAGE plpgsql AS $$
    DECLARE
      m date := date_trunc('month', p_from)::date;
      created int := 0;
      name text;
    BEGIN
      FOR i IN 1..p_months LOOP
        name := 'audit_log_' || to_char(m, 'YYYY_MM');
        IF to_regclass('platform.' || name) IS NULL THEN
          EXECUTE format('CREATE TABLE platform.%I PARTITION OF platform.audit_log FOR VALUES FROM (%L) TO (%L)',
                         name, m, (m + interval '1 month')::date);
          created := created + 1;
        END IF;
        m := (m + interval '1 month')::date;
      END LOOP;
      RETURN created;
    END $$;

    SELECT platform.ensure_audit_log_partitions('2026-10-01', 15);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $$
    DECLARE r record;
    BEGIN
      FOR r IN SELECT c.relname FROM pg_inherits i
                 JOIN pg_class c ON c.oid = i.inhrelid
                 JOIN pg_class p ON p.oid = i.inhparent
                 JOIN pg_namespace n ON n.oid = p.relnamespace
                WHERE n.nspname = 'platform' AND p.relname = 'audit_log' AND c.relname <> 'audit_log_2026_10'
      LOOP
        EXECUTE format('DROP TABLE platform.%I', r.relname);
      END LOOP;
    END $$;
    DROP FUNCTION platform.ensure_audit_log_partitions(date, int);
    DELETE FROM iam.role_permissions WHERE permission_code IN (${PERMISSIONS.map(([c]) => `'${c}'`).join(', ')});
    DELETE FROM iam.permissions WHERE code IN (${PERMISSIONS.map(([c]) => `'${c}'`).join(', ')});
  `);
};
