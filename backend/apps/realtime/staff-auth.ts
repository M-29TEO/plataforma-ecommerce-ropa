import jwt from 'jsonwebtoken';
import { verifyAccessToken } from '../../libs/shared-kernel';

/** Permiso que exige el namespace /staff (mapa en vivo y despacho del backoffice). */
export const STAFF_LIVE_PERMISSION = 'logistics.read';

export type StaffSocketAuth =
  | { ok: true; userId: string; tenantId: string; expiresAt: Date | null }
  | { ok: false; code: 'UNAUTHORIZED' | 'FORBIDDEN'; message: string };

/**
 * Verifica el JWT de acceso que manda el backoffice en el handshake (`auth: { accessToken }`) con
 * el mismo secreto, algoritmo, iss y aud que el JwtAuthGuard de la API (verifyAccessToken del
 * shared kernel). Exige staff con logistics.read. Devuelve cuándo vence para cortar el socket a esa
 * hora: un token vencido no sigue recibiendo eventos aunque la conexión siga abierta.
 */
export function authorizeStaffSocket(raw: unknown, secret: string): StaffSocketAuth {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8192) {
    return { ok: false, code: 'UNAUTHORIZED', message: 'Falta el token de acceso' };
  }
  let user;
  try {
    user = verifyAccessToken(raw, secret);
  } catch {
    return { ok: false, code: 'UNAUTHORIZED', message: 'Token inválido o expirado' };
  }
  if (user.type !== 'staff' || !user.permissions.includes(STAFF_LIVE_PERMISSION)) {
    return { ok: false, code: 'FORBIDDEN', message: 'No tienes permiso para ver la flota en vivo' };
  }
  // La firma ya se verificó arriba: decode solo lee exp.
  const exp = (jwt.decode(raw) as { exp?: number } | null)?.exp;
  return { ok: true, userId: user.id, tenantId: user.tenantId, expiresAt: typeof exp === 'number' ? new Date(exp * 1000) : null };
}
