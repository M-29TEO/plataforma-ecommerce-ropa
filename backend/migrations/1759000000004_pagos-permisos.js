/**
 * Módulos Checkout y Pagos: catálogo de permisos (iam.permissions). No cambia tablas ni columnas:
 * payments.payments, payment_events, webhook_inbox, bank_transfers y platform.idempotency_keys ya
 * existen en la migración 0001 con los índices que se usan:
 *   - UNIQUE (tenant_id, idempotency_key) en payments.payments (pago idempotente),
 *   - UNIQUE (provider, external_id) en payments.webhook_inbox (webhook idempotente),
 *   - ux_pay_provider_ref (el webhook busca el pago por la referencia de la pasarela),
 *   - ix_pay_pending (job de pagos vencidos),
 *   - PK (scope, user_ref, key) en platform.idempotency_keys (doble clic en el checkout).
 */
const PERMISSIONS = [
  ['payments.read', 'Consultar pagos, su bitácora y los comprobantes de transferencia'],
  ['payments.transfer.verify', 'Aprobar o rechazar transferencias bancarias con comprobante'],
];

exports.up = (pgm) => {
  const values = PERMISSIONS.map(([code, desc]) => `('${code}', '${desc.replace(/'/g, "''")}')`).join(',\n  ');
  pgm.sql(`
    INSERT INTO iam.permissions (code, description) VALUES
      ${values}
    ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM iam.permissions WHERE code IN (${PERMISSIONS.map(([c]) => `'${c}'`).join(', ')});`);
};
