import type { OrderDetail } from '../../orders';
import type { InvoiceSource } from '../domain/invoice';

/** Pedido (API pública de Pedidos) → lo que la factura necesita de él. */
export function invoiceSourceFrom(o: OrderDetail): InvoiceSource {
  if (!o.orderNumber) throw new Error(`El pedido ${o.id} no tiene número`);
  return {
    orderId: o.id,
    orderNumber: o.orderNumber,
    customer: { name: o.customer.name, email: o.customer.email, phone: o.customer.phone ?? null },
    billing: o.billing ?? {},
    shippingAddress: o.shippingAddress,
    paymentMethod: o.paymentMethod,
    items: o.items.map((i) => ({
      sku: i.sku,
      productName: i.productName,
      colorName: i.colorName,
      sizeCode: i.sizeCode,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      discount: i.discount,
      taxCode: i.taxCode,
      taxAmount: i.taxAmount,
    })),
    shippingTotal: o.shippingTotal,
    giftCardTotal: o.giftCardTotal,
    total: o.total,
  };
}
