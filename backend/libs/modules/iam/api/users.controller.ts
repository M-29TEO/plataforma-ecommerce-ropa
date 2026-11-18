import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AuthUser, CurrentUser, RequirePermission } from '../../../shared-kernel';
import { UserAdminService } from '../application/user-admin.service';
import { CreateStaffUserDto, ListUsersQueryDto } from './dto/users.dto';

/**
 * Gestión de usuarios (backoffice): listado y ficha (iam.users.read), alta de personal, bloqueo
 * y reseteo de contraseña (iam.users.write). Todo cambio queda en platform.audit_log.
 */
@Controller('iam/users')
export class UsersAdminController {
  constructor(private readonly users: UserAdminService) {}

  /** { items, total }, más recientes primero. Sin filtro de estado no incluye anonimizados. */
  @Get()
  @RequirePermission('iam.users.read')
  list(@CurrentUser() user: AuthUser, @Query() query: ListUsersQueryDto) {
    const { limit = 20, offset = 0, ...filter } = query;
    return this.users.list(user.tenantId, { ...filter, limit, offset });
  }

  /** Ficha con lockedUntil (bloqueo por intentos fallidos). 404 si no existe en el tenant. */
  @Get(':id')
  @RequirePermission('iam.users.read')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.get(user.tenantId, id);
  }

  /** 201 { user, temporaryPassword }. 409 EMAIL_TAKEN; 422 ROLE_NOT_ALLOWED_FOR_USER_TYPE; 404 ROLE_NOT_FOUND. */
  @Post()
  @RequirePermission('iam.users.write', 'iam.roles.assign')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateStaffUserDto, @Req() req: Request) {
    return this.users.createStaff({ actor: user, ip: req.ip ?? null }, dto);
  }

  /** Bloquea y cierra sus sesiones. 403 sobre uno mismo; 409 LAST_ADMIN; 422 si no está activo/bloqueado. */
  @Post(':id/block')
  @HttpCode(200)
  @RequirePermission('iam.users.write')
  block(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.users.block({ actor: user, ip: req.ip ?? null }, id);
  }

  @Post(':id/unblock')
  @HttpCode(200)
  @RequirePermission('iam.users.write')
  unblock(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.users.unblock({ actor: user, ip: req.ip ?? null }, id);
  }

  /** { temporaryPassword }: cierra sus sesiones y limpia el bloqueo por intentos. 403 sobre uno mismo. */
  @Post(':id/password-reset')
  @HttpCode(200)
  @RequirePermission('iam.users.write')
  resetPassword(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.users.resetPassword({ actor: user, ip: req.ip ?? null }, id);
  }
}
