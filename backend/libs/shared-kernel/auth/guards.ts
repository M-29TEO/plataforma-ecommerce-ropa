import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { AuthUser, verifyAccessToken } from './auth-user';

export const PERMISSIONS_KEY = 'required_permissions';

const permissionLogger = new Logger('Permissions');

/**
 * 403 genérico: la respuesta no enumera los permisos que faltan (no expone el modelo RBAC a quien
 * sondea); el detalle va al log junto con el usuario.
 */
export function missingPermission(missing: string[], user?: AuthUser): ForbiddenException {
  permissionLogger.warn(`Permisos faltantes para ${user?.id ?? 'anónimo'}: ${missing.join(', ')}`);
  return new ForbiddenException('No tienes permiso para esta operación');
}
export const IS_PUBLIC_KEY = 'is_public_route';

export type AuthenticatedRequest = Request & { user?: AuthUser };

function requireBearer(req: AuthenticatedRequest, secret: string): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Falta el token de acceso');
  try {
    req.user = verifyAccessToken(header.slice('Bearer '.length), secret);
  } catch {
    throw new UnauthorizedException('Token inválido o expirado');
  }
}

/** Verifica el Bearer token y deja el usuario en request.user. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    requireBearer(context.switchToHttp().getRequest<AuthenticatedRequest>(), this.config.jwtSecret);
    return true;
  }
}

/**
 * Guard global de la API (APP_GUARD): "cerrado por defecto". Toda ruta exige un JWT de acceso
 * válido salvo las marcadas con @Public() (u @OptionalAuth(), que la implica). Así una ruta
 * nueva a la que se le olvide @Auth() no queda abierta por accidente.
 */
@Injectable()
export class GlobalAuthGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    requireBearer(context.switchToHttp().getRequest<AuthenticatedRequest>(), this.config.jwtSecret);
    return true;
  }
}

/**
 * Autenticación opcional (carrito de invitado, saldo de gift card): sin header Authorization
 * la petición sigue como anónima; con un token inválido responde 401 en lugar de degradar
 * en silencio a invitado.
 */
@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = req.headers.authorization;
    if (header === undefined) return true;
    if (!header.startsWith('Bearer ')) throw new UnauthorizedException('Formato de token inválido');
    try {
      req.user = verifyAccessToken(header.slice('Bearer '.length), this.config.jwtSecret);
      return true;
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }
  }
}

/**
 * RBAC granular (APP_GUARD, después de GlobalAuthGuard): el usuario debe tener TODOS los permisos
 * declarados con @RequirePermission(...) (o el alias @Auth(...)). Los permisos vienen en el JWT.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required =
      this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [context.getHandler(), context.getClass()]) ?? [];
    if (required.length === 0) return true;
    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    const granted = new Set(user?.permissions ?? []);
    const missing = required.filter((p) => !granted.has(p));
    if (missing.length > 0) throw missingPermission(missing, user);
    return true;
  }
}

/** Nombre anterior, para el código que aún lo importe. */
export const PermissionsGuard = PermissionGuard;
