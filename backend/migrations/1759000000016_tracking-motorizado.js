/**
 * Logística: tracking en vivo del motorizado. No cambia tablas ni columnas.
 *
 *  1. Permiso nuevo logistics.dispatch (asignar un motorizado a un envío). Los roles que lo tienen
 *     los sincroniza IAM desde domain/system-roles.ts (admin y bodega).
 *  2. logistics.rider_location_history solo tenía la partición de 2026-10 (0001): desde el 1 de
 *     noviembre todo INSERT de posición fallaría. logistics.ensure_rider_location_partitions(desde,
 *     meses) crea las particiones mensuales que falten (idempotente); aquí hasta 2027-12 y el job
 *     diario del worker mantiene 3 meses por delante (mismo esquema que platform.audit_log, 0014).
 */
exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO iam.permissions (code, description) VALUES
      ('logistics.dispatch', 'Asignar motorizados a los envíos pendientes')
    ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description;

    CREATE FUNCTION logistics.ensure_rider_location_partitions(p_from date, p_months int) RETURNS int
    LANGUAGE plpgsql AS $$
    DECLARE
      m date := date_trunc('month', p_from)::date;
      created int := 0;
      name text;
    BEGIN
      FOR i IN 1..p_months LOOP
        name := 'rider_location_history_' || to_char(m, 'YYYY_MM');
        IF to_regclass('logistics.' || name) IS NULL THEN
          EXECUTE format('CREATE TABLE logistics.%I PARTITION OF logistics.rider_location_history FOR VALUES FROM (%L) TO (%L)',
                         name, m, (m + interval '1 month')::date);
          created := created + 1;
        END IF;
        m := (m + interval '1 month')::date;
      END LOOP;
      RETURN created;
    END $$;

    SELECT logistics.ensure_rider_location_partitions('2026-10-01', 15);
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
                WHERE n.nspname = 'logistics' AND p.relname = 'rider_location_history'
                  AND c.relname <> 'rider_location_history_2026_10'
      LOOP
        EXECUTE format('DROP TABLE logistics.%I', r.relname);
      END LOOP;
    END $$;
    DROP FUNCTION logistics.ensure_rider_location_partitions(date, int);
    DELETE FROM iam.role_permissions WHERE permission_code = 'logistics.dispatch';
    DELETE FROM iam.permissions WHERE code = 'logistics.dispatch';
  `);
};
