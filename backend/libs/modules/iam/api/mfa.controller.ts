import { Body, Controller, Delete, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AuthUser, CurrentUser, RateLimit, RequirePermission } from '../../../shared-kernel';
import { MfaService } from '../application/mfa.service';
import { MfaCodeDto } from './dto/auth.dto';

/** "Mi cuenta → Seguridad": activar o desactivar el 2FA con la sesión abierta. */
@Controller('me/mfa')
export class MyMfaController {
  constructor(private readonly mfa: MfaService) {}

  /** Genera un secreto pendiente y devuelve el QR. 409 si ya está activo. */
  @Post('setup')
  @HttpCode(200)
  setup(@CurrentUser() user: AuthUser) {
    return this.mfa.setupForUser(user);
  }

  /** Confirma con el primer código. 422 INVALID_MFA_CODE / MFA_SETUP_NOT_STARTED. */
  @Post('activate')
  @HttpCode(200)
  @RateLimit('auth') // adivinar el código TOTP
  activate(@CurrentUser() user: AuthUser, @Body() dto: MfaCodeDto, @Req() req: Request) {
    return this.mfa.activateForUser(user, dto.code, req.ip ?? null);
  }

  /** Desactiva con un código válido. 403 MFA_REQUIRED_FOR_ROLE para admin. */
  @Delete()
  @HttpCode(200)
  @RateLimit('auth') // adivinar el código TOTP
  disable(@CurrentUser() user: AuthUser, @Body() dto: MfaCodeDto, @Req() req: Request) {
    return this.mfa.disable(user, dto.code, req.ip ?? null);
  }
}

/** Soporte de cuentas: resetear el 2FA de quien perdió el teléfono (auditado, cierra sus sesiones). */
@Controller('iam/users')
export class MfaAdminController {
  constructor(private readonly mfa: MfaService) {}

  @Post(':userId/mfa/reset')
  @HttpCode(200)
  @RequirePermission('iam.mfa.reset')
  reset(@CurrentUser() user: AuthUser, @Param('userId', ParseUUIDPipe) userId: string, @Req() req: Request) {
    return this.mfa.reset(user, userId, req.ip ?? null);
  }
}
