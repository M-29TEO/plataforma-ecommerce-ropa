/** Solo rutas internas ("/mi-cuenta"), nunca "//otro.com" ni "https://...": evita redirecciones abiertas. */
export function safeRedirect(target: string | null | undefined, fallback = '/mi-cuenta'): string {
  if (!target || !target.startsWith('/') || target.startsWith('//') || target.startsWith('/\\')) return fallback;
  return target;
}
