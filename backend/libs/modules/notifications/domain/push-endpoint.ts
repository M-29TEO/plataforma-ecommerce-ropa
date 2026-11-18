/**
 * Endpoint de una suscripción Web Push: debe ser de un servicio push de navegador (Chrome/Edge/
 * Opera, Firefox, Safari, Windows). La suscripción la crea el navegador, pero el endpoint llega en
 * el cuerpo de la petición: sin esta lista, un cliente registraría "https://169.254.169.254/..." o
 * "https://valkey:6379" y el worker le haría un POST desde la red interna (SSRF, A10).
 * La lista vive en WEBPUSH_ALLOWED_HOSTS (config).
 */

/** "*.dominio" acepta subdominios (no el dominio pelado); el resto es comparación exacta. */
export function isAllowedPushEndpoint(endpoint: string, allowedHosts: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
  const host = url.hostname.toLowerCase();
  return allowedHosts.some((h) => (h.startsWith('*.') ? host.endsWith(h.slice(1)) && host.length > h.length - 1 : host === h));
}
