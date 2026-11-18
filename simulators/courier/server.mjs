// Courier SIMULADO (ADR-10). Imita la API de un courier nacional tipo Servientrega: cotiza,
// genera la guía (PDF) y avanza los estados del envío notificando a la tienda con webhooks
// firmados con HMAC-SHA256. Sin dependencias: solo Node.
//
// API del courier (header x-api-key):
//   POST /v1/quotes                        cotiza por servicio (tarifario + recargo por combustible)
//   POST /v1/shipments                     crea el envío y la guía (idempotente por reference + serviceCode)
//   GET  /v1/shipments/:guia               estado e historial
//   GET  /v1/shipments/:guia/label.pdf     guía en PDF (etiqueta 4×6")
//   POST /v1/shipments/:guia/cancel        anula la guía (solo antes de la recolección)
//
// Consola del simulador (red de desarrollo, sin API key, como /events de la pasarela):
//   GET  /admin/config · POST /admin/config   latencia, tasa de fallos, avance automático...
//   GET  /admin/shipments                     envíos creados
//   POST /admin/shipments/:guia/advance       avanza un estado a mano ({ "status": "NOVEDAD" } opcional)
//   GET  /events · POST /events/:id/resend    webhooks enviados y reenvío (demo de idempotencia)
//   GET  /health
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { renderLabelPdf } from './label-pdf.mjs';
import { chargeableWeightKg, quote, SERVICES } from './tariffs.mjs';

export const SIGNATURE_HEADER = 'x-couriersim-signature';
export const API_KEY_HEADER = 'x-api-key';
const RETRY_DELAYS_MS = [1_000, 3_000, 9_000, 27_000];
const QUOTE_TTL_MS = 30 * 60 * 1000;
/** Intentos de entrega fallidos antes de devolver el paquete al remitente. */
export const MAX_DELIVERY_ATTEMPTS = 2;
const MAX_BODY_BYTES = 64 * 1024;

/** Estados propios del courier (la tienda los normaliza a los suyos en su adaptador). */
export const STATUSES = {
  GUIA_GENERADA: 'Guía generada, pendiente de recolección',
  RECOLECTADO: 'Paquete recolectado en el origen',
  EN_TRANSITO: 'En tránsito hacia el centro de distribución de destino',
  EN_REPARTO: 'En ruta de entrega con el mensajero',
  ENTREGADO: 'Entregado al destinatario',
  NOVEDAD: 'Intento de entrega fallido: destinatario ausente',
  DEVUELTO: 'Devuelto al remitente tras intentos fallidos',
  ANULADO: 'Guía anulada por el remitente',
};

const TRANSITIONS = {
  GUIA_GENERADA: ['RECOLECTADO', 'ANULADO'],
  RECOLECTADO: ['EN_TRANSITO'],
  EN_TRANSITO: ['EN_REPARTO'],
  EN_REPARTO: ['ENTREGADO', 'NOVEDAD'],
  NOVEDAD: ['EN_REPARTO', 'DEVUELTO'],
  ENTREGADO: [],
  DEVUELTO: [],
  ANULADO: [],
};

export const DEFAULT_CONFIG = {
  /** Demora artificial de /v1/quotes y POST /v1/shipments (probar el timeout de 3 s de la tienda). */
  latencyMs: 0,
  /** Probabilidad [0, 1] de responder 503 en esas mismas rutas. */
  failRate: 0,
  /** Avance automático de estados y cada cuánto. */
  autoAdvance: true,
  stepMs: 20_000,
  /** Probabilidad [0, 1] de que un reparto termine en NOVEDAD (intento fallido). */
  failedAttemptRate: 0.1,
};

// ------------------------------------------------------------------ firma (igual que el backend)

export function hmacHex(secret, data) {
  return createHmac('sha256', secret).update(data).digest('hex');
}

/** `t=<unix>,v1=HMAC-SHA256(secreto, "<t>.<cuerpo crudo>")`, el mismo esquema que la pasarela. */
export function signWebhook(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${hmacHex(secret, `${timestamp}.${body}`)}`;
}

function safeEqual(a, b) {
  const [x, y] = [Buffer.from(String(a ?? '')), Buffer.from(String(b ?? ''))];
  return x.length === y.length && timingSafeEqual(x, y);
}

// ------------------------------------------------------------------ dominio del simulador

/** Siguiente estado automático: el reparto puede fallar; tras MAX intentos, devolución. */
export function nextStatus(record, random = Math.random, failedAttemptRate = DEFAULT_CONFIG.failedAttemptRate) {
  switch (record.status) {
    case 'GUIA_GENERADA':
      return 'RECOLECTADO';
    case 'RECOLECTADO':
      return 'EN_TRANSITO';
    case 'EN_TRANSITO':
      return 'EN_REPARTO';
    case 'EN_REPARTO':
      return random() < failedAttemptRate ? 'NOVEDAD' : 'ENTREGADO';
    case 'NOVEDAD':
      return record.failedAttempts >= MAX_DELIVERY_ATTEMPTS ? 'DEVUELTO' : 'EN_REPARTO';
    default:
      return null;
  }
}

export function isTerminal(status) {
  return TRANSITIONS[status]?.length === 0;
}

function locationFor(record, status) {
  if (['GUIA_GENERADA', 'RECOLECTADO', 'DEVUELTO', 'ANULADO'].includes(status)) return { city: record.sender.city };
  if (status === 'EN_TRANSITO') return { city: `Centro de distribución ${record.sender.city}` };
  return { city: record.recipient.city };
}

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const str = (v, max = 200) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

function validatePlace(p, field) {
  if (!p || !str(p.city, 80) || !str(p.province, 80)) {
    throw new HttpError(422, 'INVALID_REQUEST', `${field} requiere city y province`);
  }
}

function validateWeight(body) {
  const w = Number(body.weightKg);
  if (!Number.isFinite(w) || w <= 0 || w > 100) throw new HttpError(422, 'INVALID_REQUEST', 'weightKg debe estar entre 0 y 100');
  if (body.volumeCm3 !== undefined && !(Number(body.volumeCm3) >= 0)) {
    throw new HttpError(422, 'INVALID_REQUEST', 'volumeCm3 debe ser un número no negativo');
  }
}

// ------------------------------------------------------------------ servidor

export function createCourierSimulator({ webhookUrl, webhookSecret, apiKey, config = {}, random = Math.random, log = console }) {
  if (!webhookUrl || !webhookSecret || !apiKey) throw new Error('WEBHOOK_URL, WEBHOOK_SECRET y API_KEY son obligatorios');
  const settings = { ...DEFAULT_CONFIG, ...config };
  const shipments = new Map();
  const byReference = new Map();
  const events = new Map();
  const timers = new Set();
  let sequence = randomInt(100_000_000, 900_000_000);

  const later = (ms, fn) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    t.unref?.();
    timers.add(t);
  };

  // ---------------------------------------------------------------- webhooks

  async function deliver(record) {
    const body = JSON.stringify(record.event);
    record.attempts++;
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signWebhook(webhookSecret, body) },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      record.lastStatus = res.status;
      record.lastResponse = await res.text().catch(() => '');
      record.delivered = res.ok;
      // 4xx: la tienda lo rechazó (reintentar no sirve); 5xx o red: reintentar.
      return res.status < 500;
    } catch (error) {
      record.lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  function notify(shipment, entry) {
    const record = {
      event: {
        id: `evt_${randomUUID().replace(/-/g, '')}`,
        type: 'shipment.status_changed',
        created: Math.floor(Date.now() / 1000),
        data: {
          trackingNumber: shipment.trackingNumber,
          reference: shipment.reference,
          serviceCode: shipment.serviceCode,
          status: entry.status,
          description: entry.description,
          failedAttempts: shipment.failedAttempts,
          location: entry.location,
          occurredAt: entry.occurredAt,
          ...(entry.status === 'ENTREGADO' && shipment.codAmount > 0 ? { codCollected: shipment.codAmount.toFixed(2) } : {}),
        },
      },
      attempts: 0,
      delivered: false,
    };
    events.set(record.event.id, record);
    void (async () => {
      if (await deliver(record)) return;
      for (const delay of RETRY_DELAYS_MS) {
        await new Promise((r) => later(delay, r));
        if (await deliver(record)) return;
      }
      log.error?.(`[couriersim] webhook ${record.event.id} no entregado tras ${record.attempts} intentos`);
    })();
    return record;
  }

  // ---------------------------------------------------------------- envíos

  function transition(shipment, status) {
    if (!TRANSITIONS[shipment.status]?.includes(status)) {
      throw new HttpError(409, 'INVALID_TRANSITION', `No se puede pasar de ${shipment.status} a ${status}`, {
        allowed: TRANSITIONS[shipment.status] ?? [],
      });
    }
    if (status === 'NOVEDAD') shipment.failedAttempts++;
    shipment.status = status;
    const entry = {
      status,
      description:
        status === 'NOVEDAD' ? `${STATUSES.NOVEDAD} (intento ${shipment.failedAttempts} de ${MAX_DELIVERY_ATTEMPTS})` : STATUSES[status],
      location: locationFor(shipment, status),
      occurredAt: new Date().toISOString(),
    };
    shipment.history.push(entry);
    notify(shipment, entry);
    scheduleNext(shipment);
    return entry;
  }

  function scheduleNext(shipment) {
    if (!settings.autoAdvance || isTerminal(shipment.status)) return;
    const version = shipment.history.length;
    later(settings.stepMs, () => {
      // Si alguien lo avanzó a mano mientras tanto, este temporizador ya no aplica.
      if (shipment.history.length !== version || isTerminal(shipment.status)) return;
      const next = nextStatus(shipment, random, settings.failedAttemptRate);
      if (next) transition(shipment, next);
    });
  }

  function createShipment(body) {
    const code = String(body.serviceCode ?? '');
    if (!SERVICES[code]) throw new HttpError(422, 'INVALID_REQUEST', `serviceCode debe ser uno de: ${Object.keys(SERVICES).join(', ')}`);
    if (!str(body.reference, 60)) throw new HttpError(422, 'INVALID_REQUEST', 'reference es obligatoria (número de pedido)');
    validatePlace(body.sender, 'sender');
    validatePlace(body.recipient, 'recipient');
    if (!str(body.recipient.name, 120) || !str(body.recipient.address, 300)) {
      throw new HttpError(422, 'INVALID_REQUEST', 'recipient requiere name y address');
    }
    validateWeight(body);

    const key = `${body.reference}:${code}`;
    const existing = byReference.get(key);
    if (existing) return { shipment: shipments.get(existing), created: false };

    const q = quote({
      origin: body.sender,
      destination: body.recipient,
      weightKg: body.weightKg,
      volumeCm3: body.volumeCm3,
      services: [code],
    });
    if (q.options.length === 0) {
      throw new HttpError(422, 'NO_COVERAGE', 'El servicio no cubre ese destino o el paquete excede el peso máximo');
    }
    const cod = Number(body.codAmount ?? 0);
    if (!Number.isFinite(cod) || cod < 0) throw new HttpError(422, 'INVALID_REQUEST', 'codAmount inválido');

    const shipment = {
      trackingNumber: `SIM${++sequence}EC`,
      reference: body.reference,
      serviceCode: code,
      serviceName: SERVICES[code].name,
      sender: body.sender,
      recipient: body.recipient,
      weightKg: Number(body.weightKg),
      volumeCm3: Number(body.volumeCm3 ?? 0),
      chargeableKg: chargeableWeightKg(body.weightKg, body.volumeCm3),
      packages: Math.max(1, Math.trunc(Number(body.packages ?? 1))),
      codAmount: cod,
      price: q.options[0].price,
      etaHours: q.options[0].etaHours,
      status: 'GUIA_GENERADA',
      failedAttempts: 0,
      history: [],
      createdAt: new Date().toISOString(),
    };
    const entry = {
      status: 'GUIA_GENERADA',
      description: STATUSES.GUIA_GENERADA,
      location: locationFor(shipment, 'GUIA_GENERADA'),
      occurredAt: shipment.createdAt,
    };
    shipment.history.push(entry);
    shipments.set(shipment.trackingNumber, shipment);
    byReference.set(key, shipment.trackingNumber);
    notify(shipment, entry);
    scheduleNext(shipment);
    return { shipment, created: true };
  }

  const view = (s) => ({
    trackingNumber: s.trackingNumber,
    reference: s.reference,
    serviceCode: s.serviceCode,
    serviceName: s.serviceName,
    status: s.status,
    price: s.price,
    currency: 'USD',
    etaHours: s.etaHours,
    chargeableKg: s.chargeableKg,
    codAmount: s.codAmount.toFixed(2),
    failedAttempts: s.failedAttempts,
    labelUrl: `/v1/shipments/${s.trackingNumber}/label.pdf`,
    history: s.history,
    createdAt: s.createdAt,
  });

  // ---------------------------------------------------------------- HTTP

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY_BYTES) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Cuerpo demasiado grande');
      chunks.push(c);
    }
    if (size === 0) return {};
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value;
    } catch {
      throw new HttpError(400, 'INVALID_JSON', 'El cuerpo debe ser un objeto JSON');
    }
  }

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body, null, 2));
  };

  async function chaos() {
    if (settings.latencyMs > 0) await new Promise((r) => later(settings.latencyMs, r));
    if (settings.failRate > 0 && random() < settings.failRate) {
      throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'Servicio del courier no disponible (simulado)');
    }
  }

  function findShipment(tn) {
    const s = shipments.get(tn);
    if (!s) throw new HttpError(404, 'SHIPMENT_NOT_FOUND', `No existe la guía ${tn}`);
    return s;
  }

  function updateConfig(patch) {
    const next = { ...settings };
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULT_CONFIG)) throw new HttpError(422, 'INVALID_CONFIG', `Parámetro desconocido: ${key}`);
      if (key === 'autoAdvance') {
        if (typeof value !== 'boolean') throw new HttpError(422, 'INVALID_CONFIG', 'autoAdvance debe ser boolean');
      } else if (['failRate', 'failedAttemptRate'].includes(key)) {
        if (typeof value !== 'number' || value < 0 || value > 1) throw new HttpError(422, 'INVALID_CONFIG', `${key} debe estar entre 0 y 1`);
      } else if (typeof value !== 'number' || value < 0 || value > 600_000) {
        throw new HttpError(422, 'INVALID_CONFIG', `${key} debe estar entre 0 y 600000 ms`);
      }
      next[key] = value;
    }
    Object.assign(settings, next);
    return settings;
  }

  async function route(req, res, url) {
    const path = url.pathname;
    if (req.method === 'GET' && path === '/health') return json(res, 200, { status: 'ok' });

    // -------- consola del simulador
    if (path === '/admin/config') {
      if (req.method === 'GET') return json(res, 200, settings);
      if (req.method === 'POST') return json(res, 200, updateConfig(await readJson(req)));
    }
    if (req.method === 'GET' && path === '/admin/shipments') return json(res, 200, [...shipments.values()].map(view));
    const advance = path.match(/^\/admin\/shipments\/([A-Z0-9]+)\/advance$/);
    if (req.method === 'POST' && advance) {
      const s = findShipment(advance[1]);
      const body = await readJson(req);
      const status = body.status ?? nextStatus(s, random, settings.failedAttemptRate);
      if (!status) throw new HttpError(409, 'TERMINAL_STATUS', `La guía ya está en un estado final (${s.status})`);
      transition(s, String(status));
      return json(res, 200, view(s));
    }
    if (req.method === 'GET' && path === '/events') {
      return json(
        res,
        200,
        [...events.values()].map((r) => ({
          event: r.event,
          attempts: r.attempts,
          delivered: r.delivered,
          lastStatus: r.lastStatus ?? null,
          lastResponse: r.lastResponse ?? null,
          lastError: r.lastError ?? null,
        })),
      );
    }
    const resend = path.match(/^\/events\/([A-Za-z0-9_]+)\/resend$/);
    if (req.method === 'POST' && resend) {
      const record = events.get(resend[1]);
      if (!record) throw new HttpError(404, 'EVENT_NOT_FOUND', 'Evento desconocido');
      await deliver(record);
      return json(res, 200, { delivered: record.delivered, lastStatus: record.lastStatus ?? null, lastResponse: record.lastResponse ?? null });
    }

    // -------- API del courier
    if (path.startsWith('/v1/')) {
      if (!safeEqual(req.headers[API_KEY_HEADER], apiKey)) throw new HttpError(401, 'UNAUTHORIZED', 'API key inválida');

      if (req.method === 'POST' && path === '/v1/quotes') {
        const body = await readJson(req);
        validatePlace(body.origin, 'origin');
        validatePlace(body.destination, 'destination');
        validateWeight(body);
        await chaos();
        const q = quote(body);
        return json(res, 200, {
          quoteId: `q_${randomUUID().replace(/-/g, '')}`,
          validUntil: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
          destinationGroup: q.group,
          chargeableKg: q.chargeableKg,
          options: q.options,
        });
      }
      if (req.method === 'POST' && path === '/v1/shipments') {
        const body = await readJson(req);
        await chaos();
        const { shipment, created } = createShipment(body);
        return json(res, created ? 201 : 200, view(shipment));
      }
      const one = path.match(/^\/v1\/shipments\/([A-Z0-9]+)(\/label\.pdf|\/cancel)?$/);
      if (one) {
        const s = findShipment(one[1]);
        if (req.method === 'GET' && !one[2]) return json(res, 200, view(s));
        if (req.method === 'GET' && one[2] === '/label.pdf') {
          const pdf = renderLabelPdf(s);
          res.writeHead(200, {
            'content-type': 'application/pdf',
            'content-length': pdf.length,
            'content-disposition': `inline; filename="guia-${s.trackingNumber}.pdf"`,
            'cache-control': 'no-store',
          });
          return res.end(pdf);
        }
        if (req.method === 'POST' && one[2] === '/cancel') {
          transition(s, 'ANULADO');
          return json(res, 200, view(s));
        }
      }
    }
    throw new HttpError(404, 'NOT_FOUND', 'Ruta no encontrada');
  }

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res, new URL(req.url ?? '/', 'http://couriersim'));
    } catch (error) {
      if (error instanceof HttpError) {
        return json(res, error.status, { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
      }
      log.error?.(error);
      return json(res, 500, { error: { code: 'INTERNAL', message: 'Error interno del simulador' } });
    }
  });
  server.on('close', () => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
  });
  return { server, shipments, events, settings };
}

// Arranque como contenedor.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT ?? 3000);
  const num = (name) => (process.env[name] !== undefined && process.env[name] !== '' ? Number(process.env[name]) : undefined);
  const config = Object.fromEntries(
    Object.entries({
      latencyMs: num('LATENCY_MS'),
      failRate: num('FAIL_RATE'),
      stepMs: num('STEP_MS'),
      failedAttemptRate: num('FAILED_ATTEMPT_RATE'),
      autoAdvance: process.env.AUTO_ADVANCE ? process.env.AUTO_ADVANCE !== 'false' : undefined,
    }).filter(([, v]) => v !== undefined),
  );
  const { server, settings } = createCourierSimulator({
    webhookUrl: process.env.WEBHOOK_URL,
    webhookSecret: process.env.WEBHOOK_SECRET,
    apiKey: process.env.API_KEY,
    config,
  });
  server.listen(port, () => console.log(`[couriersim] escuchando en :${port} → webhooks a ${process.env.WEBHOOK_URL}`, settings));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
