/**
 * Destino tras el login (?next=). Solo rutas internas del backoffice: un enlace armado con
 * ?next=https://otro-sitio o //otro-sitio no puede usarse para redirigir fuera (open redirect).
 * Las rutas son relativas al basePath (/admin), como las usa el router de Next.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  if (/[\u0000-\u001f]/.test(raw)) return '/';
  if (raw === '/ingresar' || raw.startsWith('/ingresar?')) return '/';
  return raw;
}
