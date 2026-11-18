import jwt from 'jsonwebtoken';

/** Usuario autenticado tal como lo ve la aplicación (derivado del JWT de acceso). */
export interface AuthUser {
  id: string;
  tenantId: string;
  type: 'customer' | 'staff' | 'rider';
  permissions: string[];
}

/** Claims del JWT de acceso. Nombres cortos para que el token pese poco. */
interface AccessTokenClaims {
  sub: string;
  tid: string;
  typ: AuthUser['type'];
  perms: string[];
}

const ALGORITHM = 'HS256';
/** iss/aud: un token firmado con el mismo secreto para otro propósito no sirve como token de acceso. */
const ISSUER = 'moda-api';
const AUDIENCE = 'moda-access';

export function signAccessToken(user: AuthUser, secret: string, expiresInSeconds = 15 * 60): string {
  const claims: AccessTokenClaims = { sub: user.id, tid: user.tenantId, typ: user.type, perms: user.permissions };
  return jwt.sign(claims, secret, { algorithm: ALGORITHM, expiresIn: expiresInSeconds, issuer: ISSUER, audience: AUDIENCE });
}

/** Lanza si la firma, el algoritmo o la expiración no son válidos. */
export function verifyAccessToken(token: string, secret: string): AuthUser {
  const claims = jwt.verify(token, secret, { algorithms: [ALGORITHM], issuer: ISSUER, audience: AUDIENCE }) as Partial<AccessTokenClaims>;
  if (!claims.sub || !claims.tid || !claims.typ || !Array.isArray(claims.perms)) {
    throw new Error('Token sin los claims requeridos');
  }
  return { id: claims.sub, tenantId: claims.tid, type: claims.typ, permissions: claims.perms };
}
