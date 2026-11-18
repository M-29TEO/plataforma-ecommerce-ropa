import { Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig, createObjectStorage } from '../../shared-kernel';
import { CustomerPaymentsController, PaymentsController } from './api/payments.controller';
import { RefundsController } from './api/refunds.controller';
import { PaymentWebhooksController } from './api/webhooks.controller';
import { PaymentSecrets } from './application/payment-secrets';
import { PaymentService } from './application/payment.service';
import { PaymentsApi } from './application/payments.api';
import { PaymentGatewayPort, PaymentRepository, RefundRepository, VoucherStorage, WebhookInboxRepository } from './application/ports';
import { RefundService } from './application/refund.service';
import { TransferService } from './application/transfer.service';
import { WebhookService } from './application/webhook.service';
import { PaymentsConsumer } from './infrastructure/consumers/payments.consumer';
import { ExpirePendingPaymentsJob } from './infrastructure/jobs/expire-pending-payments.job';
import { PgPaymentRepository } from './infrastructure/pg-payment.repository';
import { PgRefundRepository } from './infrastructure/pg-refund.repository';
import { PgWebhookInboxRepository } from './infrastructure/pg-webhook-inbox.repository';
import { PaymentsPersonalDataContributor } from './infrastructure/personal-data.contributor';
import { SimulatorGateway } from './infrastructure/simulator/simulator.gateway';

/**
 * Módulo Pagos (schema payments: payments, payment_events, webhook_inbox, bank_transfers, refunds).
 * Requiere ConfigModule, DatabaseModule y OutboxModule del shared kernel.
 *
 * Adaptadores: PaymentGatewayPort → SimulatorGateway (PAYMENT_GATEWAY=simulator) y
 * VoucherStorage → SeaweedFS (filer HTTP) o memoria (VOUCHER_STORAGE=memory).
 */
@Module({
  controllers: [PaymentsController, CustomerPaymentsController, PaymentWebhooksController, RefundsController],
  providers: [
    { provide: PaymentRepository, useClass: PgPaymentRepository },
    { provide: WebhookInboxRepository, useClass: PgWebhookInboxRepository },
    { provide: RefundRepository, useClass: PgRefundRepository },
    { provide: PaymentGatewayPort, useClass: SimulatorGateway },
    {
      provide: VoucherStorage,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) => createObjectStorage(c.payments.voucherStorage, c.payments.seaweedFilerUrl),
    },
    PaymentSecrets,
    PaymentService,
    WebhookService,
    TransferService,
    RefundService,
    PaymentsApi,
    PaymentsPersonalDataContributor,
  ],
  // Los servicios se exportan solo para los módulos de consumidores y jobs (index.ts no los expone).
  exports: [PaymentsApi, PaymentService, RefundService],
})
export class PaymentsModule {}

/** Consumidores de eventos de otros módulos (proceso worker; en tests, junto con el relay). */
@Module({ imports: [PaymentsModule], providers: [PaymentsConsumer] })
export class PaymentsConsumersModule {}

/** Jobs del proceso worker. Requiere QueueModule. */
@Module({ imports: [PaymentsModule], providers: [ExpirePendingPaymentsJob] })
export class PaymentsWorkerModule {}
