import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConnectionOptions, Queue, Worker } from 'bullmq';
import { QUEUE_CONNECTION } from '../../../../shared-kernel';
import { PaymentService } from '../../application/payment.service';
import { RefundService } from '../../application/refund.service';

export const PAYMENTS_QUEUE = 'payments';
export const EXPIRE_PENDING_PAYMENTS = 'expire-pending-payments';
export const EXPIRE_PENDING_EVERY_MS = 60_000;
export const RETRY_GATEWAY_REFUNDS = 'retry-gateway-refunds';
export const RETRY_GATEWAY_REFUNDS_EVERY_MS = 60_000;

/**
 * Vence cada minuto los pagos pendientes cuyo plazo pasó (PaymentExpired → Pedidos cancela →
 * Inventario libera la reserva). Mismo patrón que release-expired-reservations: un scheduler
 * idempotente y SKIP LOCKED en la consulta.
 *
 * En la misma cola, cada minuto, reintenta los reversos de reembolsos que la pasarela no respondió
 * (el reverso es idempotente por refundId en la pasarela).
 */
@Injectable()
export class ExpirePendingPaymentsJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ExpirePendingPaymentsJob.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(QUEUE_CONNECTION) private readonly connection: ConnectionOptions,
    private readonly payments: PaymentService,
    private readonly refunds: RefundService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.queue = new Queue(PAYMENTS_QUEUE, { connection: this.connection });
    await this.queue.upsertJobScheduler(
      EXPIRE_PENDING_PAYMENTS,
      { every: EXPIRE_PENDING_EVERY_MS },
      { name: EXPIRE_PENDING_PAYMENTS, opts: { removeOnComplete: 100, removeOnFail: 500 } },
    );
    await this.queue.upsertJobScheduler(
      RETRY_GATEWAY_REFUNDS,
      { every: RETRY_GATEWAY_REFUNDS_EVERY_MS },
      { name: RETRY_GATEWAY_REFUNDS, opts: { removeOnComplete: 100, removeOnFail: 500 } },
    );
    this.worker = new Worker(
      PAYMENTS_QUEUE,
      async (job) => {
        if (job.name === EXPIRE_PENDING_PAYMENTS) return this.payments.expirePending();
        if (job.name === RETRY_GATEWAY_REFUNDS) return this.refunds.retryGatewayRefunds();
        return undefined;
      },
      { connection: this.connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => this.logger.error(`Job ${job?.name} falló: ${err.message}`, err.stack));
    this.logger.log(`Schedulers "${EXPIRE_PENDING_PAYMENTS}" y "${RETRY_GATEWAY_REFUNDS}" registrados (cada ${EXPIRE_PENDING_EVERY_MS / 1000} s)`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
