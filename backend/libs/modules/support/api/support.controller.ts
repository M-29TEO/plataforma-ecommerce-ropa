import { Body, Controller, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { Audited, Auth, AuthUser, CurrentUser, Public, RateLimit, TenantId } from '../../../shared-kernel';
import { Staff, TicketService } from '../application/ticket.service';
import {
  AssignTicketDto,
  CreateTicketDto,
  CsatDto,
  GuestTicketDto,
  MessageDto,
  MyTicketsQuery,
  StaffCreateTicketDto,
  StaffReplyDto,
  TicketQueueQuery,
  UpdateTicketDto,
  VersionDto,
} from './dto/support.dto';
import { TicketTokenPipe } from './ticket-token.pipe';

function assertCustomer(user: AuthUser): void {
  if (user.type !== 'customer') throw new ForbiddenException('Solo para clientes');
}

function staff(user: AuthUser): Staff {
  if (user.type !== 'staff') throw new ForbiddenException('Solo para el personal de soporte');
  return { tenantId: user.tenantId, userId: user.id };
}

/** Cliente registrado: abrir tickets (opcionalmente sobre un pedido/envío suyo), seguirlos y calificar. */
@Controller('me/tickets')
export class CustomerTicketsController {
  constructor(private readonly tickets: TicketService) {}

  @Post()
  @HttpCode(201)
  @Auth()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTicketDto) {
    assertCustomer(user);
    return this.tickets.createForCustomer({ tenantId: user.tenantId, userId: user.id, ...dto });
  }

  @Get()
  @Auth()
  list(@CurrentUser() user: AuthUser, @Query() q: MyTicketsQuery) {
    assertCustomer(user);
    return this.tickets.listForCustomer(user.tenantId, user.id, { statuses: q.status, limit: q.limit, offset: q.offset });
  }

  /** Sin notas internas. Un ticket ajeno responde 404. */
  @Get(':id')
  @Auth()
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    assertCustomer(user);
    return this.tickets.getForCustomer(user.tenantId, user.id, id);
  }

  @Post(':id/messages')
  @HttpCode(201)
  @Auth()
  reply(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MessageDto) {
    assertCustomer(user);
    return this.tickets.replyAsCustomer(user.tenantId, user.id, id, dto.body);
  }

  /** Encuesta CSAT (1 a 5), una vez, con el ticket cerrado. */
  @Post(':id/csat')
  @HttpCode(200)
  @Auth()
  rate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CsatDto) {
    assertCustomer(user);
    return this.tickets.rateAsCustomer(user.tenantId, user.id, id, dto.score, dto.comment);
  }
}

/**
 * Sin sesión. Un invitado abre un ticket con el número y el email de su pedido (header
 * X-Tenant-Id); el enlace firmado le llega por email y con él ve el ticket, responde y califica.
 * Perfil 'lookup' en todo el controlador: adivinar número de pedido + email o probar enlaces.
 */
@RateLimit('lookup')
@Controller('support')
@Public()
export class PublicTicketsController {
  constructor(private readonly tickets: TicketService) {}

  @Post('guest-tickets')
  @HttpCode(201)
  createGuest(@TenantId() tenantId: string, @Body() dto: GuestTicketDto) {
    return this.tickets.createForGuest({ tenantId, ...dto });
  }

  @Get('ticket-links/:token')
  get(@Param('token', TicketTokenPipe) token: string) {
    return this.tickets.getByToken(token);
  }

  @Post('ticket-links/:token/messages')
  @HttpCode(201)
  reply(@Param('token', TicketTokenPipe) token: string, @Body() dto: MessageDto) {
    return this.tickets.replyByToken(token, dto.body);
  }

  @Post('ticket-links/:token/csat')
  @HttpCode(200)
  rate(@Param('token', TicketTokenPipe) token: string, @Body() dto: CsatDto) {
    return this.tickets.rateByToken(token, dto.score, dto.comment);
  }
}

/** Backoffice de soporte: cola por SLA, asignación, respuestas al cliente y notas internas. */
@Controller('support/tickets')
export class SupportTicketsController {
  constructor(private readonly tickets: TicketService) {}

  /** GET /support/tickets?status=open,in_progress&assignedTo=me · ?overdue=true · ?orderId=… */
  @Get()
  @Auth('support.tickets.read')
  list(@CurrentUser() user: AuthUser, @Query() q: TicketQueueQuery) {
    return this.tickets.list(user.tenantId, {
      statuses: q.status,
      priorities: q.priority,
      categories: q.category,
      assignedTo: q.assignedTo === 'me' ? user.id : q.assignedTo?.toLowerCase(),
      requesterId: q.requesterId,
      orderId: q.orderId,
      overdue: q.overdue,
      number: q.number,
      limit: q.limit,
      offset: q.offset,
    });
  }

  /** Con notas internas y mensajes de sistema. */
  @Get(':id')
  @Auth('support.tickets.read')
  @Audited('support.ticket.view', { entity: 'ticket' })
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tickets.get(user.tenantId, id);
  }

  /** Ticket registrado por el agente (teléfono, WhatsApp, email). */
  @Post()
  @HttpCode(201)
  @Auth('support.tickets.write')
  create(@CurrentUser() user: AuthUser, @Body() dto: StaffCreateTicketDto) {
    return this.tickets.createByStaff(staff(user), dto);
  }

  @Post(':id/take')
  @HttpCode(200)
  @Auth('support.tickets.write')
  @Audited('support.ticket.take', { entity: 'ticket' })
  take(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VersionDto) {
    return this.tickets.take(staff(user), id, dto.expectedVersion, user.permissions.includes('support.tickets.assign'));
  }

  @Put(':id/assignee')
  @Auth('support.tickets.assign')
  @Audited('support.ticket.assign', { entity: 'ticket' })
  assign(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignTicketDto) {
    return this.tickets.assign(staff(user), id, dto.agentId, dto.expectedVersion);
  }

  /** Estado, prioridad (recalcula el SLA) y categoría. Cerrar envía la encuesta CSAT. */
  @Patch(':id')
  @Auth('support.tickets.write')
  @Audited('support.ticket.update', { entity: 'ticket' })
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTicketDto) {
    return this.tickets.update(staff(user), id, dto);
  }

  /** Respuesta al cliente: se envía por email. */
  @Post(':id/replies')
  @HttpCode(201)
  @Auth('support.tickets.write')
  reply(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: StaffReplyDto) {
    return this.tickets.reply(staff(user), id, dto.body, dto.status, dto.expectedVersion);
  }

  /** Nota interna: el cliente nunca la ve. */
  @Post(':id/notes')
  @HttpCode(201)
  @Auth('support.tickets.write')
  note(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MessageDto) {
    return this.tickets.addNote(staff(user), id, dto.body);
  }
}
