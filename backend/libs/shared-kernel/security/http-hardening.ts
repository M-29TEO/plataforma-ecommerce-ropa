import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import helmet from 'helmet';
import type { SecurityConfig } from '../config/app-config';
import { requestIdMiddleware } from './audit.interceptor';

/**
 * Borde HTTP de la API (A05). Caddy + ModSecurity/CRS van delante, pero la API no confía en eso:
 *  - helmet: la API solo devuelve JSON y archivos, así que la CSP es `default-src 'none'` (un HTML
 *    que se colara no ejecuta nada) y nadie la puede enmarcar (clickjacking).
 *  - CORS con lista blanca y credenciales (cookies del carrito y del refresh token). Sin
 *    CORS_ORIGINS no se aceptan orígenes cruzados: el storefront va por el mismo dominio (Caddy).
 *  - trust proxy: req.ip es la IP real del cliente solo si X-Forwarded-For viene de un proxy de confianza.
 *  - cuerpo JSON/urlencoded acotado (DoS); `rawBody` se mantiene para la firma de los webhooks.
 */
export function applyHttpHardening(app: NestExpressApplication, security: SecurityConfig): void {
  app.disable('x-powered-by');
  app.set('trust proxy', security.trustProxy);
  app.use(requestIdMiddleware);
  app.use(rejectNulBytes);
  app.use(
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } },
      // same-origin: la API se sirve en el mismo dominio que el storefront (Caddy, /api); ZAP 90004.
      crossOriginResourcePolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.use((_req: unknown, res: Response, next: () => void) => {
    // Respuestas con datos personales o de sesión: que ningún proxy ni el navegador las guarde.
    if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.enableCors({
    origin: security.corsOrigins.length > 0 ? security.corsOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Tenant-Id', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Retry-After', 'Idempotent-Replayed', 'Content-Disposition'],
    maxAge: 600,
  });
  app.useBodyParser('json', { limit: security.bodyLimit });
  app.useBodyParser('urlencoded', { limit: security.bodyLimit, extended: false });
}

/**
 * Un byte nulo (%00) en la URL no tiene uso legítimo y PostgreSQL lo rechaza en text (SQLSTATE
 * 22021): sin este corte, OWASP ZAP lo convertía en un 500 en los filtros de búsqueda. 400 de entrada.
 */
function rejectNulBytes(req: Request, res: Response, next: () => void): void {
  if (/%00/i.test(req.originalUrl ?? req.url ?? '')) {
    res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'La petición contiene un byte nulo' } });
    return;
  }
  next();
}

/** Tipos que se sirven inline; cualquier otro se descarga como binario (nunca se interpreta). */
const INLINE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

/**
 * Envía un archivo guardado (fotos, comprobantes, RIDE, XML). El Content-Type viene del almacén:
 * solo los de la lista se muestran inline; el resto (XML, HTML, SVG...) va como descarga con
 * application/octet-stream, así un archivo manipulado no corre como página en el dominio de la tienda.
 */
export function sendStoredFile(
  res: Response,
  file: { content: Buffer; contentType: string },
  opts: { filename?: string; cache?: string; download?: boolean } = {},
): void {
  const type = file.contentType.split(';')[0].trim().toLowerCase();
  const inline = !opts.download && INLINE_TYPES.has(type);
  const name = opts.filename ? `; filename="${opts.filename.replace(/[^\w.-]/g, '_')}"` : '';
  res.setHeader('Content-Type', inline || opts.download ? file.contentType : 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}${name}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // sandbox aísla el archivo como un origen opaco; el visor de PDF de Chromium no abre con sandbox.
  res.setHeader('Content-Security-Policy', type === 'application/pdf' ? "default-src 'none'" : "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', opts.cache ?? 'private, no-store');
  res.send(file.content);
}
