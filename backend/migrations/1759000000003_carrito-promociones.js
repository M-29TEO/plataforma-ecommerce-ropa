/**
 * Módulos Carrito y Promociones. No crea ni cambia tablas ni columnas (ya existen en 0001);
 * agrega permisos e índices:
 *
 *  1. Permisos de Promociones y gift cards (iam.permissions).
 *  2. ux_cart_guest_token: el carrito del invitado se busca por el hash del token de su cookie
 *     en cada petición. Sin índice sería un seq scan de sales.carts. Único porque el token
 *     (32 bytes aleatorios) identifica a un solo carrito.
 *  3. ux_redemptions_order_promotion: una promoción se canjea a lo sumo una vez por pedido.
 *     Hace idempotente el canje ante reintentos simultáneos del mismo checkout (el segundo
 *     INSERT falla y se devuelve el canje del primero) y evita descuentos duplicados.
 *  4. ix_gc_tx_order: el reembolso a gift cards de un pedido cancelado busca sus movimientos
 *     por order_id.
 */
const PERMISSIONS = [
  ['promotions.read', 'Consultar promociones, cupones y sus usos'],
  ['promotions.write', 'Crear, editar y desactivar promociones y cupones'],
  ['giftcards.read', 'Consultar gift cards y sus movimientos'],
  ['giftcards.write', 'Emitir, activar, ajustar y bloquear gift cards'],
];

exports.up = (pgm) => {
  const values = PERMISSIONS.map(([code, desc]) => `('${code}', '${desc.replace(/'/g, "''")}')`).join(',\n  ');
  pgm.sql(`
    INSERT INTO iam.permissions (code, description) VALUES
      ${values}
    ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description;

    CREATE UNIQUE INDEX ux_cart_guest_token ON sales.carts (guest_token_hash) WHERE guest_token_hash IS NOT NULL;
    CREATE UNIQUE INDEX ux_redemptions_order_promotion ON sales.promotion_redemptions (order_id, promotion_id);
    CREATE INDEX ix_gc_tx_order ON sales.gift_card_transactions (order_id) WHERE order_id IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS sales.ix_gc_tx_order;
    DROP INDEX IF EXISTS sales.ux_redemptions_order_promotion;
    DROP INDEX IF EXISTS sales.ux_cart_guest_token;
    DELETE FROM iam.permissions WHERE code IN (${PERMISSIONS.map(([c]) => `'${c}'`).join(', ')});
  `);
};
