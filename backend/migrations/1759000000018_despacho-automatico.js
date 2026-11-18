/**
 * Logística: despacho automático, turnos y prueba de entrega de la app del motorizado. Solo índices
 * (no cambia tablas ni columnas de docs/03-modelo-datos.sql):
 *
 *  1. ux_offers_shipment_open: UNA oferta abierta (response IS NULL) por envío. El servicio ya crea
 *     ofertas con la fila del envío bloqueada; el índice es la última defensa ante dos réplicas.
 *  2. ix_offers_open_expiry: el job del worker busca cada 15 s las ofertas abiertas vencidas.
 *  3. ux_shift_rider_active: un solo turno activo por motorizado (dos "iniciar turno" a la vez).
 *  4. ix_pod_otp_failures: conteo de códigos de entrega incorrectos recientes por envío (bloqueo
 *     tras 5 fallos en 15 min).
 *
 * Las ganancias y el resumen de turno usan ix_ship_rider_delivered (migración 0006).
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE UNIQUE INDEX ux_offers_shipment_open ON logistics.dispatch_offers (shipment_id) WHERE response IS NULL;
    CREATE INDEX ix_offers_open_expiry ON logistics.dispatch_offers (expires_at) WHERE response IS NULL;
    CREATE UNIQUE INDEX ux_shift_rider_active ON logistics.rider_shifts (rider_id) WHERE status = 'active';
    CREATE INDEX ix_pod_otp_failures ON logistics.delivery_proofs (shipment_id, captured_at)
      WHERE proof_type = 'otp' AND otp_verified = false;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS logistics.ix_pod_otp_failures;
    DROP INDEX IF EXISTS logistics.ux_shift_rider_active;
    DROP INDEX IF EXISTS logistics.ix_offers_open_expiry;
    DROP INDEX IF EXISTS logistics.ux_offers_shipment_open;
  `);
};
