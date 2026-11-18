import type { OrderStatus } from '@/lib/commerce-types';

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  created: 'Pendiente de pago',
  paid: 'Pagado',
  preparing: 'En preparación',
  shipped: 'Despachado',
  in_transit: 'En camino',
  delivered: 'Entregado',
  cancelled: 'Cancelado',
  partially_returned: 'Devuelto en parte',
  returned: 'Devuelto',
};

export const PAYMENT_METHOD_LABEL: Record<string, string> = {
  card: 'Tarjeta',
  deuna: 'DeUna',
  pichincha: 'Banco Pichincha',
  qr: 'Código QR',
  transfer: 'Transferencia',
  cod: 'Contra entrega',
  gift_card: 'Gift card',
};

/** Pasos visibles del pedido para la barra de progreso. */
export const ORDER_STEPS: OrderStatus[] = ['paid', 'preparing', 'shipped', 'in_transit', 'delivered'];

export function stepIndex(status: OrderStatus): number {
  if (status === 'created') return -1;
  if (status === 'partially_returned' || status === 'returned') return ORDER_STEPS.length - 1;
  return ORDER_STEPS.indexOf(status);
}
