import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Audited, Auth, AuthUser, CurrentUser, RateLimit, RequestWithId } from '../../../shared-kernel';
import { PrivacyService } from '../application/privacy.service';
import { AnonymizeAccountDto } from './dto/privacy.dto';

/** Derechos LOPDP del cliente sobre sus propios datos ("mi cuenta" → privacidad). */
@Controller('me/privacy')
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  /** Descarga JSON con todo lo que la tienda guarda del titular (acceso y portabilidad). */
  @Get('export')
  @Auth()
  @RateLimit('lookup')
  @Audited('privacy.data.export', { entity: 'user' })
  async export(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    const data = await this.privacy.exportData(user);
    res.setHeader('Content-Disposition', `attachment; filename="mis-datos-${data.generadoEn.slice(0, 10)}.json"`);
    return data;
  }

  /**
   * Anonimiza la cuenta (derecho de eliminación). Irreversible: exige la contraseña y la frase de
   * confirmación. Se audita dentro de su transacción (privacy.account.anonymized).
   */
  @Post('anonymize')
  @HttpCode(200)
  @Auth()
  @RateLimit('auth')
  anonymize(@CurrentUser() user: AuthUser, @Body() dto: AnonymizeAccountDto, @Req() req: RequestWithId) {
    return this.privacy.anonymize(user, dto.password, req.ip ?? null, req.requestId ?? null);
  }
}
