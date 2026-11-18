import { randomUUID } from 'node:crypto';
import { fromCents, toCents, ValidationError } from '../../../shared-kernel';
import { InvalidPurchaseOrderTransitionError, OverReceiptError } from './errors';

export type PurchaseOrderStatus = 'draft' | 'sent' | 'partially_received' | 'received' | 'cancelled';

export interface PurchaseOrderItem {
  id: string;
  variantId: string;
  qtyOrdered: number;
  qtyReceived: number;
  /** numeric(12,2) como string: "12.50". */
  unitCost: string;
}

export interface PurchaseOrderProps {
  id: string;
  tenantId: string;
  supplierId: string;
  warehouseId: string;
  number: string;
  status: PurchaseOrderStatus;
  expectedAt: string | null;
  total: string;
  createdBy: string | null;
  createdAt: Date;
  items: PurchaseOrderItem[];
}

export interface NewPurchaseOrder {
  tenantId: string;
  supplierId: string;
  warehouseId: string;
  number: string;
  expectedAt: string | null;
  createdBy: string | null;
  items: { variantId: string; qtyOrdered: number; unitCost: string | number }[];
}

/** Línea efectivamente recibida: lo que hay que sumar a on_hand y registrar en el ledger. */
export interface ReceiptLine {
  itemId: string;
  variantId: string;
  quantity: number;
  unitCost: string;
}

/**
 * Agregado Orden de compra.
 *
 *   draft ──send──▶ sent ──receive──▶ partially_received ──receive──▶ received
 *     │               │                    ▲       │
 *     └────cancel─────┴──▶ cancelled       └───────┘ (recepciones parciales sucesivas)
 */
export class PurchaseOrder {
  private constructor(private props: PurchaseOrderProps) {}

  static create(input: NewPurchaseOrder): PurchaseOrder {
    if (input.items.length === 0) throw new ValidationError('EMPTY_PURCHASE_ORDER', 'La orden de compra no tiene ítems');
    const seen = new Set<string>();
    const items = input.items.map((i): PurchaseOrderItem => {
      if (seen.has(i.variantId)) {
        throw new ValidationError('DUPLICATE_VARIANT', 'Una variante solo puede aparecer una vez por orden', {
          variantId: i.variantId,
        });
      }
      seen.add(i.variantId);
      if (!Number.isInteger(i.qtyOrdered) || i.qtyOrdered <= 0) {
        throw new ValidationError('INVALID_QUANTITY', 'La cantidad pedida debe ser un entero positivo', {
          variantId: i.variantId,
        });
      }
      return { id: randomUUID(), variantId: i.variantId, qtyOrdered: i.qtyOrdered, qtyReceived: 0, unitCost: fromCents(toCents(i.unitCost)) };
    });

    return new PurchaseOrder({
      id: randomUUID(),
      tenantId: input.tenantId,
      supplierId: input.supplierId,
      warehouseId: input.warehouseId,
      number: input.number,
      status: 'draft',
      expectedAt: input.expectedAt,
      total: PurchaseOrder.computeTotal(items),
      createdBy: input.createdBy,
      createdAt: new Date(),
      items,
    });
  }

  static restore(props: PurchaseOrderProps): PurchaseOrder {
    return new PurchaseOrder({ ...props, items: props.items.map((i) => ({ ...i })) });
  }

  private static computeTotal(items: PurchaseOrderItem[]): string {
    return fromCents(items.reduce((sum, i) => sum + i.qtyOrdered * toCents(i.unitCost), 0));
  }

  get id(): string {
    return this.props.id;
  }
  get status(): PurchaseOrderStatus {
    return this.props.status;
  }
  get warehouseId(): string {
    return this.props.warehouseId;
  }
  get items(): readonly PurchaseOrderItem[] {
    return this.props.items;
  }

  toJSON(): PurchaseOrderProps {
    return { ...this.props, items: this.props.items.map((i) => ({ ...i })) };
  }

  send(): void {
    if (this.props.status !== 'draft') throw new InvalidPurchaseOrderTransitionError(this.props.status, 'enviar');
    this.props.status = 'sent';
  }

  /** Solo antes de recibir mercadería; lo ya recibido está en el ledger y no se "des-recibe". */
  cancel(): void {
    if (this.props.status !== 'draft' && this.props.status !== 'sent') {
      throw new InvalidPurchaseOrderTransitionError(this.props.status, 'cancelar');
    }
    this.props.status = 'cancelled';
  }

  /**
   * Registra una recepción (total o parcial). Nunca permite recibir más de lo pendiente
   * por ítem. Deja la orden en partially_received o received según lo acumulado.
   */
  receive(lines: { itemId: string; quantity: number }[]): ReceiptLine[] {
    if (this.props.status !== 'sent' && this.props.status !== 'partially_received') {
      throw new InvalidPurchaseOrderTransitionError(this.props.status, 'recibir');
    }
    if (lines.length === 0) throw new ValidationError('EMPTY_RECEIPT', 'La recepción no tiene líneas');

    const requested = new Map<string, number>();
    for (const line of lines) {
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
        throw new ValidationError('INVALID_QUANTITY', 'Las cantidades recibidas deben ser enteros positivos', {
          itemId: line.itemId,
        });
      }
      requested.set(line.itemId, (requested.get(line.itemId) ?? 0) + line.quantity);
    }

    const receipt: ReceiptLine[] = [];
    for (const [itemId, quantity] of requested) {
      const item = this.props.items.find((i) => i.id === itemId);
      if (!item) throw new ValidationError('ITEM_NOT_IN_ORDER', 'El ítem no pertenece a la orden', { itemId });
      const pending = item.qtyOrdered - item.qtyReceived;
      if (quantity > pending) throw new OverReceiptError(itemId, pending, quantity);
      receipt.push({ itemId, variantId: item.variantId, quantity, unitCost: item.unitCost });
    }

    for (const line of receipt) {
      this.props.items.find((i) => i.id === line.itemId)!.qtyReceived += line.quantity;
    }
    const complete = this.props.items.every((i) => i.qtyReceived === i.qtyOrdered);
    this.props.status = complete ? 'received' : 'partially_received';
    return receipt;
  }
}

/** Número legible de la orden si el usuario no envía uno: OC-AAAAMMDD-XXXXXX. */
export function generatePurchaseOrderNumber(now = new Date()): string {
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
  return `OC-${ymd}-${suffix}`;
}
