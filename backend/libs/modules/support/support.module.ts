import { Module } from '@nestjs/common';
import { IamModule } from '../iam';
import { LogisticsModule } from '../logistics';
import { OrdersModule } from '../orders';
import { CustomerTicketsController, PublicTicketsController, SupportTicketsController } from './api/support.controller';
import { TicketRepository } from './application/ports';
import { SlaMonitorService } from './application/sla-monitor.service';
import { TicketService } from './application/ticket.service';
import { SupportConsumer } from './infrastructure/consumers/support.consumer';
import { SupportSlaJob } from './infrastructure/jobs/support-sla.job';
import { SupportPersonalDataContributor } from './infrastructure/personal-data.contributor';
import { PgTicketRepository } from './infrastructure/pg-ticket.repository';

/**
 * Módulo Soporte (schema support: tickets, ticket_messages). Tickets vinculados a un pedido o
 * envío (validados por las APIs de Pedidos y Logística), SLA por prioridad, asignación a agentes
 * (IAM), notas internas y encuesta CSAT. Los emails y alertas salen por Notificaciones, que
 * consume los eventos Ticket*; nadie importa este módulo, así que no crea ciclos.
 */
@Module({
  imports: [IamModule, OrdersModule, LogisticsModule],
  controllers: [CustomerTicketsController, PublicTicketsController, SupportTicketsController],
  providers: [{ provide: TicketRepository, useClass: PgTicketRepository }, TicketService, SlaMonitorService, SupportPersonalDataContributor],
  exports: [TicketService, SlaMonitorService],
})
export class SupportModule {}

/** Consumidores de eventos de otros módulos (proceso worker; en tests, junto con el relay). */
@Module({ imports: [SupportModule, OrdersModule], providers: [SupportConsumer] })
export class SupportConsumersModule {}

/** Jobs del proceso worker (SLA vencidos y cierre automático). Requiere QueueModule. */
@Module({ imports: [SupportModule], providers: [SupportSlaJob] })
export class SupportWorkerModule {}
