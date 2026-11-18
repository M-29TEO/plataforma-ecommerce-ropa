import { Body, Controller, ForbiddenException, Get, HttpCode, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Audited, Auth, AuthUser, CurrentUser } from '../../../shared-kernel';
import { ConsentService } from '../application/consent.service';
import { RecordConsentsDto } from './dto/consent.dto';

function assertCustomer(user: AuthUser): void {
  if (user.type !== 'customer') throw new ForbiddenException('Solo para clientes');
}

/** "Mi cuenta → Privacidad": consentimientos LOPDP del cliente (marketing por email, WhatsApp, SMS…). */
@Controller('me/consents')
export class MyConsentsController {
  constructor(private readonly consents: ConsentService) {}

  @Get()
  @Auth()
  list(@CurrentUser() user: AuthUser) {
    assertCustomer(user);
    return this.consents.listForUser(user.id);
  }

  /** Otorga o revoca: cada cambio queda como una fila nueva (auditoría), nunca se edita el historial. */
  @Put()
  @HttpCode(200)
  @Auth()
  @Audited('iam.consent.record', { entity: 'consent' })
  record(@CurrentUser() user: AuthUser, @Body() body: RecordConsentsDto, @Req() req: Request) {
    assertCustomer(user);
    return this.consents.record(user.id, body.consents, body.policyVersion, req.ip ?? null);
  }
}
