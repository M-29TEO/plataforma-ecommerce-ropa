import { Injectable, Logger } from '@nestjs/common';
import { Database, OutboxWriter } from '../../../shared-kernel';
import { dueReminder, firstReminderCutoff, LAST_REMINDER_STAGE } from '../domain/abandoned-cart';
import { CartAbandonedLine, cartAbandoned } from '../domain/events';
import { CartService } from './cart.service';
import { AbandonmentCandidate, CartRepository } from './ports';

export interface AbandonedCartRun {
  /** Recordatorios emitidos (eventos CartAbandoned). */
  reminded: number;
  /** Candidatos revisados (algunos todavía no tienen etapa vencida). */
  scanned: number;
}

/**
 * Cron de carrito abandonado: emite CartAbandoned (1 h, 24 h, 72 h) y Notificaciones decide si se
 * envía (consentimiento de marketing) y por qué canal.
 *
 * Cada lote es UNA transacción: las filas se toman con FOR UPDATE SKIP LOCKED, reminders_sent se
 * sube con un UPDATE condicional y el evento entra al outbox en la misma transacción. Dos réplicas
 * nunca recuerdan el mismo carrito, y si algo falla no queda ni el contador ni el evento.
 */
@Injectable()
export class AbandonedCartService {
  private readonly logger = new Logger(AbandonedCartService.name);

  constructor(
    private readonly db: Database,
    private readonly carts: CartRepository,
    private readonly pricing: CartService,
    private readonly outbox: OutboxWriter,
  ) {}

  /** tenantId limita la pasada a un tenant (tests que comparten la base). */
  processDue(now = new Date(), limit = 50, tenantId?: string): Promise<AbandonedCartRun> {
    return this.db.withTransaction(async (tx) => {
      const candidates = await this.carts.claimAbandonmentCandidates(tx, firstReminderCutoff(now), LAST_REMINDER_STAGE, limit, tenantId);
      let reminded = 0;
      for (const c of candidates) {
        const stage = dueReminder(c.remindersSent, c.lastActivityAt, now);
        if (!stage) continue;
        if (!(await this.carts.recordReminder(tx, c.id, c.remindersSent, stage.stage))) continue;
        const { lines, total, itemCount, currency } = await this.summary(c);
        await this.outbox.append(tx, [
          cartAbandoned(c.tenantId, {
            cartId: c.id,
            stage: stage.stage,
            stageLabel: stage.label,
            userId: c.userId,
            contactEmail: c.contactEmail,
            contactPhone: c.contactPhone,
            currency,
            itemCount,
            total,
            lines,
            lastActivityAt: c.lastActivityAt.toISOString(),
          }),
        ]);
        reminded++;
      }
      return { reminded, scanned: candidates.length };
    });
  }

  /** Líneas y total al precio vigente. Si el precio no se puede calcular, el recordatorio sale igual sin total. */
  private async summary(c: AbandonmentCandidate): Promise<{ lines: CartAbandonedLine[]; total: string | null; itemCount: number; currency: string }> {
    try {
      const view = await this.pricing.priceById(c.tenantId, c.id);
      return {
        currency: view.currency,
        itemCount: view.items.reduce((n, i) => n + i.quantity, 0),
        total: view.totals.total,
        lines: view.items.map((i) => ({
          variantId: i.variantId,
          productName: i.productName,
          colorName: i.colorName,
          sizeCode: i.sizeCode,
          quantity: i.quantity,
          unitPrice: i.unitPrice ?? i.priceAtAdd,
        })),
      };
    } catch (error) {
      this.logger.warn(`No se pudo calcular el carrito ${c.id} para el recordatorio: ${error instanceof Error ? error.message : String(error)}`);
      return { lines: [], total: null, itemCount: 0, currency: 'USD' };
    }
  }
}
