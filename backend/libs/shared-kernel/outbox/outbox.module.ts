import { Global, Module } from '@nestjs/common';
import { EventBus } from './event-bus';
import { OutboxRelay } from './outbox-relay';
import { OutboxRelayJob } from './outbox-relay.job';
import { OutboxWriter } from './outbox-writer';

/** Escritura en el outbox (API y worker) y registro de consumidores + relay (los usa el worker). */
@Global()
@Module({ providers: [OutboxWriter, EventBus, OutboxRelay], exports: [OutboxWriter, EventBus, OutboxRelay] })
export class OutboxModule {}

/** Solo en el proceso worker: publica el outbox periódicamente. Requiere QueueModule. */
@Module({ providers: [OutboxRelayJob] })
export class OutboxRelayWorkerModule {}
