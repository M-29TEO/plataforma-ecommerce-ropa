import { Injectable } from '@nestjs/common';
import { Database } from '../../../shared-kernel';
import { PurchaseOrderNotFoundError, SupplierNotFoundError, WarehouseInactiveError } from '../domain/errors';
import { generatePurchaseOrderNumber, PurchaseOrder, PurchaseOrderProps } from '../domain/purchase-order';
import { CatalogVariants } from './catalog-variants';
import { PurchaseOrderFilter, PurchaseOrderRepository, StockRepository, SupplierRepository, WarehouseRepository } from './ports';

export interface CreatePurchaseOrderInput {
  supplierId: string;
  warehouseId: string;
  number?: string;
  expectedAt?: string | null;
  items: { variantId: string; qtyOrdered: number; unitCost: string | number }[];
}

export interface ReceivePurchaseOrderInput {
  lines: { itemId: string; quantity: number }[];
  note?: string;
}

@Injectable()
export class PurchaseOrderService {
  constructor(
    private readonly db: Database,
    private readonly orders: PurchaseOrderRepository,
    private readonly suppliers: SupplierRepository,
    private readonly warehouses: WarehouseRepository,
    private readonly stock: StockRepository,
    private readonly variants: CatalogVariants,
  ) {}

  async create(tenantId: string, userId: string, input: CreatePurchaseOrderInput): Promise<PurchaseOrderProps> {
    await this.variants.assertOfTenant(tenantId, input.items.map((i) => i.variantId));
    return this.db.withTransaction(async (tx) => {
      const supplier = await this.suppliers.findById(tx, tenantId, input.supplierId);
      if (!supplier?.active) throw new SupplierNotFoundError(input.supplierId);
      const active = await this.warehouses.findActiveIds(tx, tenantId, [input.warehouseId]);
      if (!active.has(input.warehouseId)) throw new WarehouseInactiveError([input.warehouseId]);

      const po = PurchaseOrder.create({
        tenantId,
        supplierId: input.supplierId,
        warehouseId: input.warehouseId,
        number: input.number?.trim() || generatePurchaseOrderNumber(),
        expectedAt: input.expectedAt ?? null,
        createdBy: userId,
        items: input.items,
      });
      await this.orders.insert(tx, po);
      return po.toJSON();
    });
  }

  async get(tenantId: string, id: string): Promise<PurchaseOrderProps> {
    const po = await this.orders.findById(this.db, tenantId, id);
    if (!po) throw new PurchaseOrderNotFoundError(id);
    return po.toJSON();
  }

  async list(tenantId: string, filter: PurchaseOrderFilter): Promise<PurchaseOrderProps[]> {
    const orders = await this.orders.list(this.db, tenantId, { ...filter, limit: Math.min(filter.limit, 100) });
    return orders.map((po) => po.toJSON());
  }

  send(tenantId: string, id: string): Promise<PurchaseOrderProps> {
    return this.transition(tenantId, id, (po) => po.send());
  }

  cancel(tenantId: string, id: string): Promise<PurchaseOrderProps> {
    return this.transition(tenantId, id, (po) => po.cancel());
  }

  /**
   * Recepción total o parcial. Por cada línea recibida: on_hand += cantidad y un movimiento
   * 'purchase' con el costo unitario en el ledger. La orden queda partially_received o
   * received. La fila de la orden se bloquea (FOR UPDATE) para que dos recepciones
   * simultáneas no reciban dos veces lo mismo.
   */
  receive(tenantId: string, userId: string, id: string, input: ReceivePurchaseOrderInput): Promise<PurchaseOrderProps> {
    return this.db.withTransaction(async (tx) => {
      const po = await this.orders.findById(tx, tenantId, id, { forUpdate: true });
      if (!po) throw new PurchaseOrderNotFoundError(id);

      const receipt = po.receive(input.lines).sort((a, b) => (a.variantId < b.variantId ? -1 : 1));
      for (const line of receipt) {
        await this.stock.applyOnHandDelta(tx, line.variantId, po.warehouseId, line.quantity);
      }
      await this.stock.insertMovements(
        tx,
        receipt.map((line) => ({
          variantId: line.variantId,
          warehouseId: po.warehouseId,
          quantity: line.quantity,
          movementType: 'purchase' as const,
          referenceType: 'purchase_order',
          referenceId: po.id,
          unitCost: line.unitCost,
          reason: input.note?.trim() || null,
          userId,
        })),
      );
      await this.orders.save(tx, po);
      return po.toJSON();
    });
  }

  private transition(tenantId: string, id: string, action: (po: PurchaseOrder) => void): Promise<PurchaseOrderProps> {
    return this.db.withTransaction(async (tx) => {
      const po = await this.orders.findById(tx, tenantId, id, { forUpdate: true });
      if (!po) throw new PurchaseOrderNotFoundError(id);
      action(po);
      await this.orders.save(tx, po);
      return po.toJSON();
    });
  }
}
