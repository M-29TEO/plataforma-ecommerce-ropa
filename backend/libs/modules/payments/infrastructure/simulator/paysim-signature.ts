import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Esquema de firma de la pasarela simulada (el mismo que usa simulators/payments/server.mjs).
 *
 * Webhook: header `X-Paysim-Signature: t=<unix>,v1=<hex>` con
 *   v1 = HMAC-SHA256(secreto, `${t}.${cuerpo crudo}`)
 * Se firma el cuerpo CRUDO (no el JSON re-serializado) y la marca de tiempo va dentro de la firma,
 * así un webhook capturado no se puede reenviar pasada la tolerancia (anti replay).
 *
 * Pedido de pago (URL de redirección): sig = HMAC-SHA256(secreto, parámetros ordenados k=v&...),
 * para que el simulador rechace una URL con el monto adulterado.
 */
export const SIGNATURE_HEADER = 'x-paysim-signature';

export function hmacHex(secret: string, data: string | Buffer): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

export function signWebhook(secret: string, rawBody: string | Buffer, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${hmacHex(secret, Buffer.concat([Buffer.from(`${timestamp}.`), Buffer.from(rawBody)]))}`;
}

export function verifyWebhookSignature(
  secret: string,
  rawBody: Buffer,
  header: string | undefined,
  toleranceSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!header) return false;
  const parts = new Map(
    header.split(',').map((p) => {
      const eq = p.indexOf('=');
      return [p.slice(0, eq).trim(), p.slice(eq + 1).trim()] as const;
    }),
  );
  const t = Number(parts.get('t'));
  const v1 = parts.get('v1') ?? '';
  if (!Number.isInteger(t) || Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  if (!/^[0-9a-f]{64}$/.test(v1)) return false;
  const expected = hmacHex(secret, Buffer.concat([Buffer.from(`${t}.`), rawBody]));
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(v1, 'hex'));
}

/** Cadena canónica de los parámetros del pedido de pago: claves ordenadas, valores URL-encoded. */
export function canonicalParams(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join('&');
}

export function signParams(secret: string, params: Record<string, string>): string {
  return hmacHex(secret, canonicalParams(params));
}
