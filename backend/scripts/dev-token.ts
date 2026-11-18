/**
 * Emite un JWT de acceso de desarrollo. Los clientes ya pueden usar POST /v1/auth/login; este
 * script sigue siendo la forma de obtener tokens de staff con permisos mientras IAM no tenga roles.
 *
 *   npm run token:dev -- <tenantId> <userId> [permiso1,permiso2,...] [--customer | --rider]
 *
 * Sin lista de permisos, incluye todos los de Inventario, Pedidos, Promociones, gift cards, Pagos, Logística, Facturación,
 * Devoluciones, CRM, moderación de reseñas, Soporte y Reportes (usuario staff). Para probar la doble aprobación de reembolsos, emite tokens de dos userId distintos.
 * Con --customer emite un token de cliente sin permisos (para /v1/me/orders, /v1/cart y /v1/checkout).
 * Con --rider, uno de motorizado sin permisos (para /v1/rider/...; userId = riderUserId del seed).
 */
import { signAccessToken } from '../libs/shared-kernel/auth/auth-user';

const ALL = [
  'inventory.read',
  'inventory.warehouse.write',
  'inventory.stock.write',
  'inventory.adjust',
  'inventory.supplier.write',
  'inventory.purchase.write',
  'inventory.purchase.receive',
  'orders.read',
  'orders.status.update',
  'orders.cancel',
  'orders.payment.confirm',
  'promotions.read',
  'promotions.write',
  'giftcards.read',
  'giftcards.write',
  'payments.read',
  'payments.transfer.verify',
  'logistics.read',
  'logistics.zone.write',
  'logistics.dispatch',
  'logistics.settlement.manage',
  'logistics.settlement.approve',
  'billing.read',
  'returns.read',
  'returns.approve',
  'returns.inspect',
  'payments.refund.approve',
  'payments.refund.complete',
  'crm.read',
  'crm.loyalty.adjust',
  'crm.tiers.write',
  'catalog.reviews.moderate',
  'catalog.questions.answer',
  'support.tickets.read',
  'support.tickets.write',
  'support.tickets.assign',
  'reports.sales.read',
  'reports.delivery.read',
  'reports.funnel.read',
  'reports.export',
];

// Un token de staff con todos los permisos y 8 h de vigencia, sin login ni 2FA: nunca en producción.
if (process.env.NODE_ENV === 'production') {
  console.error('token:dev está deshabilitado con NODE_ENV=production; usa POST /v1/auth/login');
  process.exit(1);
}

const args = process.argv.slice(2);
const customer = args.includes('--customer');
const rider = args.includes('--rider');
const [tenantId, userId, perms] = args.filter((a) => a !== '--customer' && a !== '--rider');
const secret = process.env.JWT_SECRET;
if (!tenantId || !userId || !secret) {
  console.error(
    'Uso: npm run token:dev -- <tenantId> <userId> [permisos,separados,por,coma] [--customer | --rider]  (requiere JWT_SECRET)',
  );
  process.exit(1);
}

const permissions = customer || rider ? [] : perms ? perms.split(',').map((p) => p.trim()).filter(Boolean) : ALL;
// 8 horas: comodidad para probar a mano. Los tokens reales de IAM durarán 15 minutos.
console.log(
  signAccessToken({ id: userId, tenantId, type: customer ? 'customer' : rider ? 'rider' : 'staff', permissions }, secret, 8 * 60 * 60),
);
