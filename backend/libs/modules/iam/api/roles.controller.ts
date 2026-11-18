import { Controller, Delete, Get, Param, ParseUUIDPipe, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AuthUser, CurrentUser, MatchesPipe, RequirePermission } from '../../../shared-kernel';
import { RoleService } from '../application/role.service';

/** Código de rol (admin, manager... o uno propio del tenant): se acota antes de consultar. */
const ROLE_CODE = new MatchesPipe(/^[a-z][a-z0-9_.-]{1,39}$/, 'código de rol');

/**
 * Administración de roles (backoffice). Asignar y quitar exige iam.roles.assign (solo admin) y
 * queda en platform.audit_log. El cambio rige en el siguiente login o refresh del usuario.
 */
@Controller('iam')
export class RolesAdminController {
  constructor(private readonly roles: RoleService) {}

  /** Roles del tenant con sus permisos. */
  @Get('roles')
  @RequirePermission('iam.roles.read')
  list(@CurrentUser() user: AuthUser) {
    return this.roles.listRoles(user.tenantId);
  }

  @Get('users/:userId/roles')
  @RequirePermission('iam.roles.read')
  userRoles(@CurrentUser() user: AuthUser, @Param('userId', ParseUUIDPipe) userId: string) {
    return this.roles.listUserRoles(user.tenantId, userId);
  }

  /** Idempotente: 200 con los roles del usuario. 403 sobre uno mismo; 422 si el rol no es para su tipo. */
  @Put('users/:userId/roles/:code')
  @RequirePermission('iam.roles.assign')
  assign(@CurrentUser() user: AuthUser, @Param('userId', ParseUUIDPipe) userId: string, @Param('code', ROLE_CODE) code: string, @Req() req: Request) {
    return this.roles.assign({ actor: user, ip: req.ip ?? null }, userId, code);
  }

  /** 200 con los roles que le quedan. 404 si no lo tenía; 409 LAST_ADMIN. */
  @Delete('users/:userId/roles/:code')
  @RequirePermission('iam.roles.assign')
  remove(@CurrentUser() user: AuthUser, @Param('userId', ParseUUIDPipe) userId: string, @Param('code', ROLE_CODE) code: string, @Req() req: Request) {
    return this.roles.remove({ actor: user, ip: req.ip ?? null }, userId, code);
  }
}
