import type { TicketPriority } from './ticket';

/** Horas para resolver un ticket según su prioridad (horas corridas, no laborables). */
export type SlaPolicy = Readonly<Record<TicketPriority, number>>;

export const DEFAULT_SLA_HOURS: SlaPolicy = { urgent: 4, high: 8, normal: 24, low: 72 };

/**
 * Vencimiento del SLA: desde la creación del ticket. Si cambia la prioridad se recalcula desde la
 * misma creación (subir a urgente un ticket de hace 6 h lo deja vencido de inmediato).
 */
export function slaDueAt(createdAt: Date, priority: TicketPriority, policy: SlaPolicy): Date {
  return new Date(createdAt.getTime() + policy[priority] * 3_600_000);
}

/**
 * Estados en los que corre el reloj y se alerta el vencimiento. 'pending_customer' no alerta: la
 * pelota está del lado del cliente. Si el cliente responde después del vencimiento, el ticket
 * vuelve a 'in_progress' (u 'open') y la alerta sale en la siguiente pasada del job.
 */
export const SLA_ALERT_STATUSES = ['open', 'in_progress'] as const;
