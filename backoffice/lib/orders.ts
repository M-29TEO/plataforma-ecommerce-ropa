import type { Tone } from '@/components/ui/Badge';

/**
 * Tipos de /v1/orders y la máquina de estados del pedido replicada del backend
 * (backend/libs/modules/orders/domain/order-status.ts y PERMISSION_FOR de orders.controller.ts)
 * para ofrecer SOLO las transiciones válidas que el usuario puede hacer. El backend vuelve a
 * validar todo: esto evita botones que terminarían en 403/409.
 */

export const ORDER_STATUSES = [
  'created',
  'paid',
  'preparing',
  'shipped',
  'in_transit',
  'delivered',
  'cancelled',
  'partially_returned',
  'returned',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PAYMENT_STATUSES = ['pending', 'authorized', 'paid', 'cod_pending', 'partially_refunded', 'refunded', 'failed'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_METHODS = ['card', 'deuna', 'pichincha', 'transfer', 'qr', 'cod', 'gift_card'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const FULFILLMENT_TYPES = ['rider', 'courier', 'pickup'] as const;
export type FulfillmentType = (typeof FULFILLMENT_TYPES)[number];

export const CHANNELS = ['web', 'app', 'whatsapp', 'backoffice', 'store'] as const;
export type OrderChannel = (typeof CHANNELS)[number];

export type ActorType = 'customer' | 'staff' | 'rider' | 'system' | 'courier';

export const ORDER_STATUS: Record<OrderStatus, [string, Tone]> = {
  created: ['Creado', 'neutral'],
  paid: ['Pagado', 'info'],
  preparing: ['En preparación', 'accent'],
  shipped: ['Despachado', 'info'],
  in_transit: ['En camino', 'info'],
  delivered: ['Entregado', 'ok'],
  cancelled: ['Cancelado', 'danger'],
  partially_returned: ['Devuelto parcial', 'warn'],
  returned: ['Devuelto', 'warn'],
};

export const PAYMENT_STATUS: Record<PaymentStatus, [string, Tone]> = {
  pending: ['Pendiente', 'neutral'],
  authorized: ['Autorizado', 'info'],
  paid: ['Pagado', 'ok'],
  cod_pending: ['Contra entrega', 'warn'],
  partially_refunded: ['Reembolso parcial', 'warn'],
  refunded: ['Reembolsado', 'accent'],
  failed: ['Fallido', 'danger'],
};

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  card: 'Tarjeta',
  deuna: 'DeUna',
  pichincha: 'Banco Pichincha',
  transfer: 'Transferencia',
  qr: 'QR',
  cod: 'Contra entrega',
  gift_card: 'Tarjeta de regalo',
};

export const FULFILLMENT_LABEL: Record<FulfillmentType, string> = {
  rider: 'Motorizado',
  courier: 'Courier',
  pickup: 'Retiro en tienda',
};

export const CHANNEL_LABEL: Record<OrderChannel, string> = {
  web: 'Web',
  app: 'App',
  whatsapp: 'WhatsApp',
  backoffice: 'Backoffice',
  store: 'Tienda',
};

export const ACTOR_LABEL: Record<ActorType, string> = {
  customer: 'Cliente',
  staff: 'Personal',
  rider: 'Motorizado',
  system: 'Sistema',
  courier: 'Courier',
};

export interface OrderItem {
  id: string;
  variantId: string;
  productId: string;
  sku: string;
  productName: string;
  brandName: string | null;
  categoryPath: string | null;
  colorName: string | null;
  sizeCode: string | null;
  quantity: number;
  unitPrice: string;
  discount: string;
  taxCode: string;
  taxRate: string;
  taxAmount: string;
  lineTotal: string;
  unitCost: string | null;
  warehouseId: string | null;
  qtyReturned: number;
}

export interface OrderHeader {
  id: string;
  orderNumber: string | null;
  userId: string | null;
  cartId: string | null;
  customer: { name: string; email: string; phone?: string; idType?: string; idNumber?: string };
  billing: Record<string, unknown>;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod;
  fulfillmentType: FulfillmentType;
  shippingAddress: Record<string, unknown> | null;
  shippingLocation: { lat: number; lng: number } | null;
  shippingCity: string | null;
  shippingZoneId: string | null;
  deliverySlotId: string | null;
  sourceWarehouseId: string | null;
  currency: string;
  subtotal: string;
  discountTotal: string;
  shippingTotal: string;
  taxTotal: string;
  giftCardTotal: string;
  total: string;
  costTotal: string | null;
  channel: OrderChannel;
  sellerId: string | null;
  notes: string | null;
  cancelReason: string | null;
  placedAt: string;
  paidAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  version: number;
  updatedAt: string;
}

/** GET /orders (arreglo, sin total). */
export type OrderSummary = OrderHeader & { itemCount: number };

export interface StatusHistoryEntry {
  id: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  actorType: ActorType;
  actorId: string | null;
  reason: string | null;
  createdAt: string;
}

/** GET /orders/:id */
export type OrderDetail = OrderHeader & { items: OrderItem[]; history: StatusHistoryEntry[] };

// ---------------------------------------------------------------- Máquina de estados
export const TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  created: ['paid', 'preparing', 'cancelled'],
  paid: ['preparing', 'cancelled'],
  preparing: ['shipped', 'delivered', 'cancelled'],
  shipped: ['in_transit'],
  in_transit: ['delivered'],
  delivered: ['partially_returned', 'returned'],
  cancelled: [],
  partially_returned: ['returned'],
  returned: [],
};

/** Los estados de devolución los fija el flujo de devoluciones, no el botón de estado. */
export type ManualOrderStatus = Exclude<OrderStatus, 'partially_returned' | 'returned'>;

export const PERMISSION_FOR: Record<ManualOrderStatus, string> = {
  created: 'orders.status.update',
  paid: 'orders.payment.confirm',
  preparing: 'orders.status.update',
  shipped: 'orders.status.update',
  in_transit: 'orders.status.update',
  delivered: 'orders.status.update',
  cancelled: 'orders.cancel',
};

export const REASON_REQUIRED: ReadonlySet<OrderStatus> = new Set<OrderStatus>(['cancelled', 'partially_returned', 'returned']);

const RIDER_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>(['in_transit', 'delivered']);

export interface TransitionContext {
  paymentMethod: PaymentMethod;
  fulfillmentType: FulfillmentType;
}

const GUARDS: Partial<Record<`${OrderStatus}->${OrderStatus}`, (ctx: TransitionContext) => string | null>> = {
  'created->paid': (ctx) => (ctx.paymentMethod === 'cod' ? 'Un pedido contra entrega se cobra al entregarlo' : null),
  'created->preparing': (ctx) => (ctx.paymentMethod === 'cod' ? null : 'El pedido debe estar pagado antes de prepararlo'),
  'preparing->shipped': (ctx) => (ctx.fulfillmentType === 'pickup' ? 'Un pedido de retiro en tienda no se despacha' : null),
  'preparing->delivered': (ctx) => (ctx.fulfillmentType === 'pickup' ? null : 'Solo un pedido de retiro en tienda se entrega sin despacho'),
};

export function isManualStatus(s: OrderStatus): s is ManualOrderStatus {
  return s !== 'partially_returned' && s !== 'returned';
}

export function canTransition(from: OrderStatus, to: OrderStatus, ctx: TransitionContext): boolean {
  return TRANSITIONS[from].includes(to) && (GUARDS[`${from}->${to}`]?.(ctx) ?? null) === null;
}

export const ACTION_LABEL: Record<ManualOrderStatus, string> = {
  created: 'Volver a creado',
  paid: 'Confirmar pago',
  preparing: 'Pasar a preparación',
  shipped: 'Marcar despachado',
  in_transit: 'Marcar en camino',
  delivered: 'Marcar entregado',
  cancelled: 'Cancelar pedido',
};

export interface AvailableTransition {
  to: ManualOrderStatus;
  label: string;
  permission: string;
  reasonRequired: boolean;
  danger: boolean;
}

/**
 * Transiciones que este usuario puede ejecutar sobre el pedido: válidas según la tabla y sus
 * condiciones (COD, retiro en tienda), fijables a mano y con el permiso del estado destino.
 * Un motorizado solo puede marcar en camino / entregado (igual que el controller).
 */
export function availableTransitions(
  order: { status: OrderStatus } & TransitionContext,
  permissions: readonly string[],
  userType: 'staff' | 'rider' | 'customer' = 'staff',
): AvailableTransition[] {
  if (userType === 'customer') return [];
  return TRANSITIONS[order.status]
    .filter(isManualStatus)
    .filter((to) => canTransition(order.status, to, order))
    .filter((to) => permissions.includes(PERMISSION_FOR[to]))
    .filter((to) => userType !== 'rider' || RIDER_STATUSES.has(to))
    .map((to) => ({
      to,
      label: ACTION_LABEL[to],
      permission: PERMISSION_FOR[to],
      reasonRequired: REASON_REQUIRED.has(to),
      danger: to === 'cancelled',
    }));
}

// ---------------------------------------------------------------- Filtros y presentación
/** Ecuador continental: UTC−5 sin horario de verano. */
const STORE_OFFSET = '-05:00';

/**
 * Rango de fechas del filtro (AAAA-MM-DD en hora de Ecuador) → from/to ISO del API, que filtra
 * [from, to) sobre placed_at: "hasta" incluye todo ese día.
 */
export function dateRangeQuery(from: string, to: string): { from?: string; to?: string } {
  const out: { from?: string; to?: string } = {};
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) out.from = new Date(`${from}T00:00:00${STORE_OFFSET}`).toISOString();
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    const end = new Date(`${to}T00:00:00${STORE_OFFSET}`);
    end.setUTCDate(end.getUTCDate() + 1);
    out.to = end.toISOString();
  }
  return out;
}

const ADDRESS_LABELS: Record<string, string> = {
  recipientName: 'Recibe',
  recipient: 'Recibe',
  name: 'Nombre',
  phone: 'Teléfono',
  mainStreet: 'Calle principal',
  secondaryStreet: 'Calle secundaria',
  street: 'Calle',
  number: 'Número',
  neighborhood: 'Barrio',
  parish: 'Parroquia',
  city: 'Ciudad',
  canton: 'Cantón',
  province: 'Provincia',
  postalCode: 'Código postal',
  reference: 'Referencia',
  line1: 'Dirección',
  line2: 'Dirección (2)',
  idType: 'Tipo de identificación',
  idNumber: 'Identificación',
  email: 'Email',
  address: 'Dirección',
  businessName: 'Razón social',
};

/** Objeto jsonb (dirección, facturación) → pares etiqueta/valor legibles, sin vacíos ni coordenadas. */
export function addressLines(addr: Record<string, unknown> | null | undefined): [string, string][] {
  if (!addr) return [];
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(addr)) {
    if (v === null || v === undefined || v === '' || k === 'lat' || k === 'lng' || typeof v === 'object') continue;
    out.push([ADDRESS_LABELS[k] ?? k, String(v)]);
  }
  return out;
}

export function orderNumberLabel(o: { orderNumber: string | null; id: string }): string {
  return o.orderNumber ? `#${o.orderNumber}` : o.id.slice(0, 8);
}
