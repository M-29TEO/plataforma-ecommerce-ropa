import { applyDecorators, BadRequestException, createParamDecorator, ExecutionContext, SetMetadata, UseGuards } from '@nestjs/common';
import { AuthUser } from './auth-user';
import { AuthenticatedRequest, IS_PUBLIC_KEY, JwtAuthGuard, OptionalJwtAuthGuard, PERMISSIONS_KEY, PermissionGuard } from './guards';

/**
 * Ruta abierta: el GlobalAuthGuard no exige JWT (registro, login, health, webhooks firmados,
 * enlaces firmados de invitado). Sin @Public() ni @OptionalAuth(), toda ruta exige token.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Exige TODOS los permisos indicados; los verifica el PermissionGuard global con los permisos
 * del JWT (403 si falta alguno). La autenticación ya la exige el GlobalAuthGuard.
 * Ejemplo: @RequirePermission('catalog.product.write')
 */
export const RequirePermission = (...permissions: string[]) => SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * Alias anterior de @RequirePermission (sin argumentos: solo exige usuario autenticado). Aplica
 * además los guards a nivel de ruta, así protege también en un módulo de pruebas sin los APP_GUARD.
 * Ejemplo: @Auth('inventory.adjust')
 */
export function Auth(...permissions: string[]) {
  return applyDecorators(SetMetadata(PERMISSIONS_KEY, permissions), UseGuards(JwtAuthGuard, PermissionGuard));
}

/** Acepta peticiones anónimas (implica @Public()); si llega un Bearer token, lo verifica. Usar con @OptionalUser(). */
export function OptionalAuth() {
  return applyDecorators(Public(), UseGuards(OptionalJwtAuthGuard));
}

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const user = ctx.switchToHttp().getRequest<AuthenticatedRequest>().user;
  if (!user) throw new Error('CurrentUser usado en una ruta sin @Auth()');
  return user;
});

/** Usuario autenticado o undefined (rutas con @OptionalAuth()). */
export const OptionalUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser | undefined => ctx.switchToHttp().getRequest<AuthenticatedRequest>().user,
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TENANT_HEADER = 'x-tenant-id';

/**
 * Tenant de la petición: el del token si hay usuario; si es anónima (invitado), el header
 * X-Tenant-Id que fija Caddy según el dominio de la tienda. Con usuario, el header se ignora.
 */
export const TenantId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  if (req.user) return req.user.tenantId;
  const raw = req.headers[TENANT_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !UUID_RE.test(value)) throw new BadRequestException(`Falta el header ${TENANT_HEADER} (uuid del tenant)`);
  return value.toLowerCase();
});
