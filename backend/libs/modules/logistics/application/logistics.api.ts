import { Injectable } from '@nestjs/common';
import { Database } from '../../../shared-kernel';
import {
  BookDeliveryInput,
  DeliveryQuote,
  DeliveryQuoteInput,
  DeliveryQuoteService,
  ResolveDeliveryInput,
  ResolvedDelivery,
} from './delivery-quote.service';
import { OutboundShipmentInfo } from './handoff-ports';
import { HandoffResult, HandoffService, ReadyForPickupInput } from './handoff.service';
import { ShipmentRepository, ShipmentSummary } from './ports';
import { ExchangeShipmentInput, ReturnPickupInput, ReverseLogisticsService, ReverseShipmentResult } from './reverse-logistics.service';

/**
 * Fachada síncrona del módulo Logística para otros módulos (Checkout y el orquestador de posventa). Nadie fuera de
 * Logística conoce sus repositorios, sus adaptadores (OSRM, couriers) ni el schema logistics.
 */
@Injectable()
export class LogisticsApi {
  constructor(
    private readonly db: Database,
    private readonly quotes: DeliveryQuoteService,
    private readonly shipments: ShipmentRepository,
    private readonly reverse: ReverseLogisticsService,
    private readonly handoff: HandoffService,
  ) {}

  /** Picking (orquestador fulfillment): envío de despacho vigente de cada pedido, con su franja. */
  getOutboundShipments(tenantId: string, orderIds: string[]): Promise<Map<string, OutboundShipmentInfo>> {
    return this.handoff.outboundByOrder(tenantId, orderIds);
  }

  /** Picking terminado: el envío queda 'ready_for_pickup' (retiro en tienda: se crea ya listo). Idempotente. */
  markReadyForPickup(input: ReadyForPickupInput): Promise<HandoffResult> {
    return this.handoff.markReadyForPickup(input);
  }

  /** Opciones de entrega para una dirección y un paquete. Llamar FUERA de una transacción (OSRM, couriers). */
  quoteDelivery(input: DeliveryQuoteInput): Promise<DeliveryQuote> {
    return this.quotes.quote(input);
  }

  /** Checkout: valida la opción elegida (quoteId + franja) y devuelve el envío a cobrar. */
  resolveDelivery(input: ResolveDeliveryInput): Promise<ResolvedDelivery> {
    return this.quotes.resolve(input);
  }

  /** Checkout (misma transacción): reserva el cupo de la franja y crea el envío 'pending'. */
  bookDelivery(input: BookDeliveryInput): Promise<{ shipmentId: string; trackingToken: string }> {
    return this.quotes.book(input);
  }

  getShipments(tenantId: string, orderId: string): Promise<ShipmentSummary[]> {
    return this.shipments.findByOrder(this.db, tenantId, orderId);
  }

  /** Devolución aprobada: envío 'pending' de retiro (direction 'return'). Idempotente por devolución. */
  scheduleReturnPickup(input: ReturnPickupInput): Promise<ReverseShipmentResult> {
    return this.reverse.scheduleReturnPickup(input);
  }

  /** Bodega recibió la devolución: el retiro queda 'delivered'. Idempotente. */
  markReturnReceived(tenantId: string, returnId: string, warehouseId: string | null = null): Promise<ShipmentSummary> {
    return this.reverse.markReturnReceived(tenantId, returnId, warehouseId);
  }

  /** Cambio de talla: envío 'pending' con la variante nueva (direction 'exchange'). Idempotente por devolución. */
  createExchangeShipment(input: ExchangeShipmentInput): Promise<ReverseShipmentResult> {
    return this.reverse.createExchangeShipment(input);
  }

  getReturnShipment(tenantId: string, returnId: string, direction: 'return' | 'exchange' = 'return'): Promise<ShipmentSummary | null> {
    return this.reverse.getReturnShipment(tenantId, returnId, direction);
  }
}
