/**
 * Seguridad (docs/07-seguridad.md). Cambios aprobados el 2026-10-02:
 *
 *  1. platform.audit_log append-only: un trigger rechaza UPDATE y DELETE (también para el dueño
 *     de la tabla, al que un REVOKE no le aplica: la app se conecta como el usuario que la creó).
 *     TRUNCATE también queda bloqueado. Las particiones viejas se archivan con DETACH PARTITION
 *     (DDL de un DBA, no de la app). Las particiones mensuales las crea ya la migración 0014.
 *  2. platform.push_subscriptions: p256dh y auth (el secreto con que se cifra cada push) pasan a
 *     keys_enc bytea, cifrado en la aplicación con libsodium (FieldCipher, DATA_ENCRYPTION_KEY),
 *     como pide docs/02-stack-open-source.md §2.7 para los campos *_enc. SQL no tiene la clave, así
 *     que las suscripciones existentes se borran: el navegador se vuelve a suscribir solo (la PWA
 *     llama a pushManager.subscribe al abrir) y en desarrollo no hay datos reales.
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE FUNCTION platform.audit_log_append_only() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'platform.audit_log es de solo inserción (% no permitido)', TG_OP
        USING ERRCODE = 'insufficient_privilege';
    END $$;

    CREATE TRIGGER tr_audit_log_append_only
      BEFORE UPDATE OR DELETE ON platform.audit_log
      FOR EACH ROW EXECUTE FUNCTION platform.audit_log_append_only();
    CREATE TRIGGER tr_audit_log_no_truncate
      BEFORE TRUNCATE ON platform.audit_log
      FOR EACH STATEMENT EXECUTE FUNCTION platform.audit_log_append_only();

    DELETE FROM platform.push_subscriptions;
    ALTER TABLE platform.push_subscriptions
      DROP COLUMN p256dh,
      DROP COLUMN auth,
      ADD COLUMN keys_enc bytea NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM platform.push_subscriptions;
    ALTER TABLE platform.push_subscriptions
      DROP COLUMN keys_enc,
      ADD COLUMN p256dh text NOT NULL,
      ADD COLUMN auth text NOT NULL;

    DROP TRIGGER tr_audit_log_no_truncate ON platform.audit_log;
    DROP TRIGGER tr_audit_log_append_only ON platform.audit_log;
    DROP FUNCTION platform.audit_log_append_only();
  `);
};
