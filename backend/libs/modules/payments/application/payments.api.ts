import { Injectable } from '@nestjs/common';
import { PaymentMethod } from '../domain/payment';
import { RefundPart } from '../domain/refund';
import { CreatePaymentInput, PaymentCreated, PaymentService, PublicPaymentView } from './payment.service';
import { ApproveRefundResult, RefundService, RefundView, RequestRefundInput } from './refund.service';
import { TransferService, VoucherInput } from './transfer.service';

/**
 * Fachada síncrona para otros módulos. Checkout crea el pago dentro de su transacción; el orquestador
 * de posventa solicita, aprueba y ejecuta reembolsos. El resto de los efectos (captura, rechazo,
 * vencimiento, reembolso completado) salen como eventos del outbox.
 */
@Injectable()
export class PaymentsApi {
  constructor(
    private readonly payments: PaymentService,
    private readonly refunds: RefundService,
    private readonly transfers: TransferService,
  ) {}

  /** Idempotente por input.idempotencyKey. */
  createPayment(input: CreatePaymentInput): Promise<PaymentCreated> {
    return this.payments.create(input);
  }

  /** Segundos hasta que vence un pago de este método (null: no vence). */
  paymentTtlSeconds(method: PaymentMethod): number | null {
    return this.payments.paymentTtlSeconds(method);
  }

  /**
   * Pedidos asistidos: el vendedor sube el comprobante de la transferencia del pedido sin el client
   * secret (mismas validaciones que POST /payments/:id/transfer/voucher). El pago queda pending
   * hasta que alguien con payments.transfer.verify lo apruebe o rechace. El llamador debe validar
   * que el pedido le corresponde (canal backoffice del tenant).
   */
  submitTransferVoucherAsStaff(tenantId: string, orderId: string, staffId: string, input: VoucherInput): Promise<PublicPaymentView> {
    return this.transfers.submitVoucherAsStaff(tenantId, orderId, staffId, input);
  }

  // ------------------------------------------------------------------ reembolsos (orquestador de posventa)

  /** Devolución inspeccionada: reembolso pendiente de aprobación. Idempotente por devolución. */
  requestRefund(input: RequestRefundInput): Promise<RefundView> {
    return this.refunds.request(input);
  }

  /** Una aprobación; con la completa devuelve el plan (el llamador ejecuta las partes en gift card). */
  approveRefund(tenantId: string, refundId: string, approverId: string): Promise<ApproveRefundResult> {
    return this.refunds.approve(tenantId, refundId, approverId);
  }

  /** Parte interna ejecutada (gift_cards / store_credit) con su referencia. Idempotente. */
  completeRefundPart(tenantId: string, refundId: string, part: RefundPart, reference: string): Promise<RefundView> {
    return this.refunds.completePart(tenantId, refundId, part, reference);
  }

  /** Reverso en la pasarela. Llamar FUERA de una transacción (I/O). */
  executeGatewayRefund(tenantId: string, refundId: string): Promise<RefundView> {
    return this.refunds.executeGateway(tenantId, refundId);
  }

  getRefund(tenantId: string, refundId: string): Promise<RefundView> {
    return this.refunds.get(tenantId, refundId);
  }

  findRefundByReturn(tenantId: string, returnId: string): Promise<RefundView | null> {
    return this.refunds.findByReturn(tenantId, returnId);
  }
}
