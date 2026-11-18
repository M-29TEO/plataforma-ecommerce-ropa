/** Claims del JWT de acceso que emite IAM (ver shared-kernel/auth/auth-user.ts del backend). */
export interface AccessClaims {
  sub: string;
  tid: string;
  typ: 'customer' | 'staff' | 'rider';
  perms: string[];
  exp?: number;
}

/**
 * Lee los claims del access token SIN verificar la firma: solo sirve para armar el menú. La
 * verificación real la hace la API en cada petición.
 */
export function decodeClaims(token: string): AccessClaims | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const json = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    const c = JSON.parse(json) as Partial<AccessClaims>;
    if (typeof c.sub !== 'string' || typeof c.tid !== 'string' || typeof c.typ !== 'string') return null;
    return { sub: c.sub, tid: c.tid, typ: c.typ, perms: Array.isArray(c.perms) ? c.perms.filter((p) => typeof p === 'string') : [], exp: c.exp };
  } catch {
    return null;
  }
}
