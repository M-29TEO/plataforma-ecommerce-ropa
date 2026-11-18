import { Inject, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { metrics, ObservableGauge, ObservableResult } from '@opentelemetry/api';
import { ConnectionOptions, Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUE_CONNECTION } from './queue.module';

/** Estados que se reportan (los de getJobCounts de BullMQ). */
export const QUEUE_STATES = ['waiting', 'active', 'delayed', 'prioritized', 'waiting-children', 'failed', 'completed'] as const;
const PREFIX = 'bull';
const SCAN_COUNT = 200;

/**
 * Profundidad de las colas de BullMQ como métrica OTel `bullmq.queue.jobs{queue,state}`
 * (en Prometheus: bullmq_queue_jobs). Va en el worker, que es el que procesa las colas.
 *
 * Las colas se descubren en Valkey (cada Queue de BullMQ deja la clave bull:<nombre>:meta al
 * crearse), así que un módulo nuevo con su cola aparece solo, sin registrar nada aquí ni
 * importar internos de los módulos. Los conteos se leen cuando el SDK exporta (cada 15 s).
 */
@Injectable()
export class QueueMetrics implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueMetrics.name);
  private readonly queues = new Map<string, Queue>();
  private redis?: Redis;
  private gauge?: ObservableGauge;
  private readonly callback = (result: ObservableResult) => this.observe(result);

  constructor(@Inject(QUEUE_CONNECTION) private readonly connection: ConnectionOptions) {}

  onModuleInit(): void {
    this.redis = new Redis({ ...(this.connection as object), lazyConnect: true, maxRetriesPerRequest: 1 });
    this.gauge = metrics.getMeter('moda').createObservableGauge('bullmq.queue.jobs', {
      description: 'Jobs por cola de BullMQ y estado',
      unit: '{job}',
    });
    this.gauge.addCallback(this.callback);
  }

  async onModuleDestroy(): Promise<void> {
    this.gauge?.removeCallback(this.callback);
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.redis?.disconnect();
  }

  /** Nombres de las colas que existen en Valkey. */
  async discover(): Promise<string[]> {
    const names = new Set<string>();
    let cursor = '0';
    do {
      const [next, keys] = await this.redis!.scan(cursor, 'MATCH', `${PREFIX}:*:meta`, 'COUNT', SCAN_COUNT);
      cursor = next;
      for (const key of keys) names.add(key.slice(PREFIX.length + 1, -':meta'.length));
    } while (cursor !== '0');
    return [...names].sort();
  }

  /** Conteos por cola y estado. */
  async counts(): Promise<Record<string, Record<string, number>>> {
    const out: Record<string, Record<string, number>> = {};
    for (const name of await this.discover()) {
      let queue = this.queues.get(name);
      if (!queue) {
        // skipMetasUpdate: esta Queue solo lee; no pisa la configuración de la cola real.
        queue = new Queue(name, { connection: this.connection, skipMetasUpdate: true });
        this.queues.set(name, queue);
      }
      out[name] = await queue.getJobCounts(...QUEUE_STATES);
    }
    return out;
  }

  private async observe(result: ObservableResult): Promise<void> {
    try {
      for (const [queue, byState] of Object.entries(await this.counts())) {
        for (const state of QUEUE_STATES) result.observe(byState[state] ?? 0, { queue, state });
      }
    } catch (e) {
      this.logger.warn(`No se pudo leer la profundidad de las colas: ${(e as Error).message}`);
    }
  }
}

/** Solo en el worker: la API no necesita reportar las colas (y así no se duplica la serie). */
@Module({ providers: [QueueMetrics], exports: [QueueMetrics] })
export class QueueMetricsModule {}
