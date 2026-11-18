import { Injectable } from '@nestjs/common';

/** Evento tal como lo entrega el relay (fila de platform.outbox_events). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- payload JSON genérico; cada handler tipa el suyo
export interface PublishedEvent<P extends object = Record<string, any>> {
  id: string;
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  eventVersion: number;
  payload: P;
  occurredAt: Date;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- payload JSON genérico; cada handler tipa el suyo
export type EventHandler<P extends object = Record<string, any>> = (event: PublishedEvent<P>) => Promise<void>;

interface Subscription {
  consumer: string;
  handler: EventHandler;
}

/**
 * Registro de consumidores de eventos de dominio (en el proceso worker). Cada módulo suscribe
 * sus handlers en onModuleInit; el OutboxRelay los invoca al publicar cada evento.
 *
 * Entrega "al menos una vez": un handler puede recibir el mismo evento más de una vez (reintento
 * tras un fallo), así que TODOS deben ser idempotentes.
 */
@Injectable()
export class EventBus {
  private readonly subscriptions = new Map<string, Subscription[]>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- payload JSON genérico; cada handler tipa el suyo
  subscribe<P extends object = Record<string, any>>(eventType: string, consumer: string, handler: EventHandler<P>): void {
    const list = this.subscriptions.get(eventType) ?? [];
    if (list.some((s) => s.consumer === consumer)) {
      throw new Error(`El consumidor ${consumer} ya está suscrito a ${eventType}`);
    }
    list.push({ consumer, handler: handler as EventHandler });
    this.subscriptions.set(eventType, list);
  }

  handlersFor(eventType: string): readonly Subscription[] {
    return this.subscriptions.get(eventType) ?? [];
  }
}
