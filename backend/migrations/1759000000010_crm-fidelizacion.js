/**
 * Módulo CRM y Fidelización (schema crm): direcciones, wishlist, puntos, niveles y referidos.
 * Cambios al modelo aprobados el 2026-10-01:
 *
 *  1. tenant_id NOT NULL en customer_profiles, addresses, wishlist_items, loyalty_accounts,
 *     loyalty_transactions y referrals. Justificación: las tablas solo tenían user_id, y saber el
 *     tenant exigía un join con iam.users (prohibido entre schemas). Los jobs (maduración de puntos,
 *     alertas de la wishlist) recorren por tenant y los tests de integración comparten la base.
 *     Se rellena desde iam.users para filas existentes (en la práctica, ninguna: el módulo es nuevo).
 *  2. crm.wishlist_items: last_known_price, last_known_in_stock y last_alerted_at. Para avisar
 *     "volvió a haber stock" o "bajó el precio" hay que recordar el estado anterior; last_alerted_at
 *     evita mandar varias alertas seguidas del mismo producto.
 *  3. crm.loyalty_transactions.reference: origen del movimiento (pedido de una acumulación,
 *     devolución de una reversa, gift card de un canje). Un pedido puede tener varias devoluciones
 *     y order_id solo no distingue las reversas: con el índice único (tenant, type, reference) el
 *     consumidor de eventos es idempotente (un evento repetido no descuenta dos veces). En los
 *     ajustes manuales ('adjust') guarda el motivo y no es único.
 *
 * Índices: una dirección predeterminada por usuario, la wishlist por tenant y producto (job de
 * alertas), los puntos pendientes por available_at (job de maduración) y los referidos por
 * referente y por pedido calificante. CHECK de saldos y niveles no negativos (última defensa).
 * Permisos: crm.read, crm.loyalty.adjust y crm.tiers.write.
 */
const PERMISSIONS = [
  ['crm.read', 'Consultar clientes: direcciones, wishlist, cuenta de puntos, niveles y referidos'],
  ['crm.loyalty.adjust', 'Ajustar manualmente los puntos de un cliente (con motivo)'],
  ['crm.tiers.write', 'Crear, editar y eliminar niveles del programa de puntos'],
];

const TENANT_TABLES = ['customer_profiles', 'addresses', 'wishlist_items', 'loyalty_accounts', 'loyalty_transactions', 'referrals'];

/** Columna con el usuario de cada tabla (referrals: el referente). */
const USER_COLUMN = { referrals: 'referrer_id' };

exports.up = (pgm) => {
  for (const table of TENANT_TABLES) {
    const userColumn = USER_COLUMN[table] ?? 'user_id';
    pgm.sql(`
      ALTER TABLE crm.${table} ADD COLUMN tenant_id uuid REFERENCES iam.tenants(id);
      UPDATE crm.${table} t SET tenant_id = u.tenant_id FROM iam.users u WHERE u.id = t.${userColumn};
      ALTER TABLE crm.${table} ALTER COLUMN tenant_id SET NOT NULL;
    `);
  }

  const values = PERMISSIONS.map(([code, desc]) => `('${code}', '${desc.replace(/'/g, "''")}')`).join(',\n  ');
  pgm.sql(`
    ALTER TABLE crm.wishlist_items
      ADD COLUMN last_known_price numeric(12,2),
      ADD COLUMN last_known_in_stock boolean,
      ADD COLUMN last_alerted_at timestamptz;

    ALTER TABLE crm.loyalty_transactions ADD COLUMN reference text;

    CREATE UNIQUE INDEX ux_addr_default ON crm.addresses (user_id) WHERE is_default;
    CREATE INDEX ix_wishlist_tenant_product ON crm.wishlist_items (tenant_id, product_id);
    CREATE UNIQUE INDEX ux_lt_reference ON crm.loyalty_transactions (tenant_id, type, reference)
      WHERE reference IS NOT NULL AND type <> 'adjust';
    CREATE INDEX ix_lt_pending ON crm.loyalty_transactions (tenant_id, available_at) WHERE status = 'pending';
    CREATE INDEX ix_lt_order ON crm.loyalty_transactions (order_id) WHERE order_id IS NOT NULL;
    CREATE INDEX ix_referrals_referrer ON crm.referrals (referrer_id, created_at DESC);
    CREATE INDEX ix_referrals_order ON crm.referrals (qualifying_order) WHERE qualifying_order IS NOT NULL;
    CREATE INDEX ix_profiles_tenant ON crm.customer_profiles (tenant_id);

    ALTER TABLE crm.loyalty_accounts
      ADD CONSTRAINT ck_la_points CHECK (points_pending >= 0 AND lifetime_points >= 0);
    ALTER TABLE crm.loyalty_tiers
      ADD CONSTRAINT ck_tiers_values CHECK (min_points >= 0 AND multiplier > 0),
      ADD CONSTRAINT ux_tiers_name UNIQUE (tenant_id, name);

    INSERT INTO iam.permissions (code, description) VALUES
      ${values}
    ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM iam.permissions WHERE code IN (${PERMISSIONS.map(([c]) => `'${c}'`).join(', ')});
    ALTER TABLE crm.loyalty_tiers DROP CONSTRAINT IF EXISTS ux_tiers_name, DROP CONSTRAINT IF EXISTS ck_tiers_values;
    ALTER TABLE crm.loyalty_accounts DROP CONSTRAINT IF EXISTS ck_la_points;
    DROP INDEX IF EXISTS crm.ix_profiles_tenant;
    DROP INDEX IF EXISTS crm.ix_referrals_order;
    DROP INDEX IF EXISTS crm.ix_referrals_referrer;
    DROP INDEX IF EXISTS crm.ix_lt_order;
    DROP INDEX IF EXISTS crm.ix_lt_pending;
    DROP INDEX IF EXISTS crm.ux_lt_reference;
    DROP INDEX IF EXISTS crm.ix_wishlist_tenant_product;
    DROP INDEX IF EXISTS crm.ux_addr_default;
    ALTER TABLE crm.loyalty_transactions DROP COLUMN IF EXISTS reference;
    ALTER TABLE crm.wishlist_items
      DROP COLUMN IF EXISTS last_alerted_at,
      DROP COLUMN IF EXISTS last_known_in_stock,
      DROP COLUMN IF EXISTS last_known_price;
  `);
  for (const table of TENANT_TABLES) pgm.sql(`ALTER TABLE crm.${table} DROP COLUMN IF EXISTS tenant_id;`);
};
