import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Database, sniffFileType } from '../../../shared-kernel';
import { InvalidVoucherError, PaymentNotFoundError, TransferOperationError, VoucherUnderReviewError } from '../domain/errors';
import { Payment } from '../domain/payment';
import { PaymentService, PublicPaymentView, publicView } from './payment.service';
import { PaymentSecrets } from './payment-secrets';
import { PaymentRepository, VoucherStorage } from './ports';

export interface VoucherFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

export interface VoucherInput {
  bankName: string;
  reference?: string | null;
  file: VoucherFile | undefined;
}

export const VOUCHER_MAX_BYTES = 5 * 1024 * 1024;
const VOUCHER_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };

/**
 * Transferencia bancaria con comprobante:
 *  1. Checkout crea el pago en requires_action y muestra la cuenta y la referencia.
 *  2. El cliente transfiere y sube el comprobante (jpg, png o pdf) → pending (por verificar). Una
 *     sola vez: en pending ya no se reemplaza (409 VOUCHER_ALREADY_SUBMITTED).
 *  3. El backoffice lo aprueba (→ captured, PaymentCaptured) o lo rechaza (→ failed, PaymentFailed).
 * Si nada de esto ocurre antes de expires_at, el job lo vence y se libera el stock.
 */
@Injectable()
export class TransferService {
  constructor(
    private readonly db: Database,
    private readonly payments: PaymentRepository,
    private readonly paymentService: PaymentService,
    private readonly secrets: PaymentSecrets,
    private readonly storage: VoucherStorage,
  ) {}

  async submitVoucher(
    tenantId: string,
    paymentId: string,
    clientSecret: string | undefined,
    input: VoucherInput,
  ): Promise<PublicPaymentView> {
    const payment = await this.payments.findById(this.db, tenantId, paymentId);
    if (!payment || !this.secrets.verify(paymentId, clientSecret)) throw new PaymentNotFoundError({ paymentId });
    return this.storeVoucher(payment, input, undefined, 'voucher');
  }

  /**
   * Pedido asistido: el vendedor sube el comprobante que el cliente le mandó por WhatsApp. Sin
   * client secret (staff autenticado; el llamador valida que el pedido es suyo de canal backoffice),
   * mismas validaciones y mismo resultado: queda pending para que otra persona lo verifique.
   */
  async submitVoucherAsStaff(tenantId: string, orderId: string, staffId: string, input: VoucherInput): Promise<PublicPaymentView> {
    // El pago por transferencia abierto del pedido (o el último, para que el error diga su estado).
    const payments = (await this.payments.findByOrder(this.db, tenantId, orderId)).filter((p) => p.method === 'transfer');
    const payment = payments.find((p) => p.isOpen) ?? payments.at(-1);
    if (!payment) {
      throw new TransferOperationError('NOT_A_TRANSFER', 'El pedido no se paga por transferencia', { orderId });
    }
    return this.storeVoucher(payment, input, `staff:${staffId}`, 'file');
  }

  /** Valida (tipo por magic bytes, tamaño), guarda el archivo y pasa el pago a pending. */
  private async storeVoucher(payment: Payment, input: VoucherInput, submittedBy: string | undefined, field: string): Promise<PublicPaymentView> {
    const { tenantId, id: paymentId } = payment.toJSON();
    this.assertTransfer(payment);
    // Antes de subir nada: un comprobante en revisión no se reemplaza (lo vuelve a exigir el dominio
    // dentro de la transacción, con el pago bloqueado).
    if (payment.status === 'pending') throw new VoucherUnderReviewError(paymentId, payment.status);
    const file = input.file;
    if (!file || file.size === 0) throw new InvalidVoucherError('VOUCHER_REQUIRED', `Adjunta el comprobante (campo "${field}")`);
    const ext = VOUCHER_TYPES[file.mimetype];
    if (!ext) throw new InvalidVoucherError('VOUCHER_TYPE', 'El comprobante debe ser JPG, PNG o PDF', { mimetype: file.mimetype });
    if (file.size > VOUCHER_MAX_BYTES) throw new InvalidVoucherError('VOUCHER_TOO_LARGE', 'El comprobante supera 5 MB');
    // El Content-Type lo elige el cliente: se exige que el contenido real coincida.
    if (sniffFileType(file.buffer) !== file.mimetype) {
      throw new InvalidVoucherError('VOUCHER_TYPE', 'El archivo no es un JPG, PNG o PDF válido', { mimetype: file.mimetype });
    }

    // El archivo se sube antes de la transacción (I/O lento). Si la transacción falla queda un
    // archivo huérfano, que no referencia nada.
    const voucherKey = `payments/vouchers/${tenantId}/${paymentId}/${randomUUID()}.${ext}`;
    await this.storage.put(voucherKey, file.buffer, file.mimetype);

    return this.db.withTransaction(async (tx) => {
      const locked = await this.payments.findById(tx, tenantId, paymentId, { forUpdate: true });
      if (!locked) throw new PaymentNotFoundError({ paymentId });
      const change = locked.submitTransferVoucher(voucherKey, new Date(), submittedBy);
      await this.payments.upsertBankTransfer(tx, {
        paymentId,
        bankName: input.bankName.trim(),
        reference: input.reference?.trim() || null,
        voucherKey,
      });
      await this.paymentService.apply(tx, locked, change);
      return publicView(locked.toJSON());
    });
  }

  /** Backoffice: el dinero está en la cuenta. Emite PaymentCaptured (Pedidos → paid). */
  approve(tenantId: string, paymentId: string, reviewerId: string) {
    return this.review(tenantId, paymentId, reviewerId, null);
  }

  /** Backoffice: el comprobante no corresponde. Emite PaymentFailed (Pedidos cancela, se libera el stock). */
  reject(tenantId: string, paymentId: string, reviewerId: string, reason: string) {
    return this.review(tenantId, paymentId, reviewerId, reason.trim());
  }

  async getVoucher(tenantId: string, paymentId: string): Promise<{ content: Buffer; contentType: string }> {
    const payment = await this.payments.findById(this.db, tenantId, paymentId);
    if (!payment) throw new PaymentNotFoundError({ paymentId });
    const transfer = await this.payments.findBankTransfer(this.db, paymentId);
    const file = transfer?.voucherKey ? await this.storage.get(transfer.voucherKey) : null;
    if (!file) throw new PaymentNotFoundError({ paymentId, voucher: true });
    return file;
  }

  private async review(tenantId: string, paymentId: string, reviewerId: string, rejectionReason: string | null) {
    await this.db.withTransaction(async (tx) => {
      const payment = await this.payments.findById(tx, tenantId, paymentId, { forUpdate: true });
      if (!payment) throw new PaymentNotFoundError({ paymentId });
      this.assertTransfer(payment);
      const transfer = await this.payments.findBankTransfer(tx, paymentId);
      if (!transfer?.voucherKey || payment.status !== 'pending') {
        throw new TransferOperationError('VOUCHER_NOT_SUBMITTED', 'El cliente todavía no subió el comprobante', {
          paymentId,
          status: payment.status,
        });
      }
      const change =
        rejectionReason === null
          ? payment.capture({ source: `backoffice:${reviewerId}` })
          : payment.fail('TRANSFER_REJECTED', rejectionReason, `backoffice:${reviewerId}`);
      await this.payments.reviewBankTransfer(tx, paymentId, reviewerId, rejectionReason);
      await this.paymentService.apply(tx, payment, change);
    });
    return this.paymentService.get(tenantId, paymentId);
  }

  private assertTransfer(payment: Payment): void {
    if (payment.method !== 'transfer') {
      throw new TransferOperationError('NOT_A_TRANSFER', 'El pago no es por transferencia', { paymentId: payment.id });
    }
  }
}
