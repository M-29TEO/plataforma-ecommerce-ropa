/**
 * Logística: calificaciones mutuas y liquidaciones de motorizados. NO cambia tablas ni columnas
 * (ratings, rider_settlements y rider_settlement_items ya existen en la migración 0001).
 *
 *  1. Permisos: logistics.settlement.manage (generar y disputar) y logistics.settlement.approve
 *     (aprobar con el efectivo rendido y marcar pagada). Se separan para que quien arma la
 *     liquidación no sea quien la aprueba.
 *  2. Índices:
 *     - ix_ratings_ratee (ratee_id, rater_type): el promedio del motorizado se recalcula desde
 *       ratings en cada calificación; sin índice sería un seq scan de toda la tabla.
 *     - ix_ship_rider_delivered (rider_id, delivered_at) parcial en entregas de motorizado: la
 *       consulta de entregas sin liquidar del job semanal.
 *  3. CHECK (última defensa ante SQL manual; el dominio ya lo garantiza):
 *     - riders.cod_balance >= 0: el efectivo en mano nunca es negativo (la aprobación no deja rendir
 *       más de lo que tiene).
 *     - rider_settlements: period_end >= period_start y montos no negativos.
 */
const PERMISSIONS = [
  ['logistics.settlement.manage', 'Generar liquidaciones de motorizados y marcarlas en disputa'],
  ['logistics.settlement.approve', 'Aprobar liquidaciones de motorizados (con el efectivo rendido) y marcarlas pagadas'],
];

exports.up = (pgm) => {
  const values = PERMISSIONS.map(([code, desc]) => `('${code}', '${desc.replace(/'/g, "''")}')`).join(',\n  ');
  pgm.sql(`
    INSERT INTO iam.permissions (code, description) VALUES
      ${values}
    ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description;

    CREATE INDEX IF NOT EXISTS ix_ratings_ratee ON logistics.ratings (ratee_id, rater_type);
    CREATE INDEX IF NOT EXISTS ix_ship_rider_delivered ON logistics.shipments (rider_id, delivered_at)
      WHERE status = 'delivered' AND carrier_type = 'rider';

    ALTER TABLE logistics.riders
      ADD CONSTRAINT ck_riders_cod_balance CHECK (cod_balance >= 0);
    ALTER TABLE logistics.rider_settlements
      ADD CONSTRAINT ck_settlement_period CHECK (period_end >= period_start),
      ADD CONSTRAINT ck_settlement_amounts CHECK (
        deliveries_count >= 0 AND gross_fees >= 0 AND bonuses >= 0 AND deductions >= 0
        AND cod_collected >= 0 AND cod_remitted >= 0 AND net_payable >= 0);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE logistics.rider_settlements
      DROP CONSTRAINT IF EXISTS ck_settlement_period,
      DROP CONSTRAINT IF EXISTS ck_settlement_amounts;
    ALTER TABLE logistics.riders DROP CONSTRAINT IF EXISTS ck_riders_cod_balance;
    DROP INDEX IF EXISTS logistics.ix_ship_rider_delivered;
    DROP INDEX IF EXISTS logistics.ix_ratings_ratee;
    DELETE FROM iam.permissions WHERE code IN (${PERMISSIONS.map(([c]) => `'${c}'`).join(', ')});
  `);
};
