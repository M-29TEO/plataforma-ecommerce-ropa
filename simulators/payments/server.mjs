// Pasarela de pago SIMULADA (ADR-10). Imita a Datafast/Payphone/DeUna: página de pago donde se
// aprueba o rechaza y webhook firmado con HMAC-SHA256 hacia la tienda. Sin dependencias: solo Node.
//
//   GET  /pay?ref&amount&currency&order&method&exp&return&sig   página de pago (sig = HMAC de los parámetros)
//   POST /pay/decision                                          aprobar o rechazar → envía el webhook
//   POST /events/:id/resend                                     reenvía el MISMO evento (demo de idempotencia)
//   GET  /events                                                eventos enviados y su entrega (JSON)
//   POST /refunds                                               reverso de un cobro aprobado (servidor a servidor, cuerpo firmado)
//   GET  /refunds                                               reversos hechos (JSON)
//   GET  /health
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const SIGNATURE_HEADER = 'x-paysim-signature';
const PARAMS = ['ref', 'amount', 'currency', 'order', 'method', 'exp', 'return'];
const RETRY_DELAYS_MS = [1_000, 3_000, 9_000, 27_000];

export const REJECTIONS = {
  INSUFFICIENT_FUNDS: 'Fondos insuficientes',
  CARD_DECLINED: 'Tarjeta rechazada por el banco emisor',
  SUSPECTED_FRAUD: 'Transacción sospechosa de fraude',
};

const METHOD_LABELS = { card: 'Tarjeta de crédito/débito', deuna: 'DeUna', pichincha: 'Banco Pichincha', qr: 'Pago con QR' };

// ------------------------------------------------------------------ firma (igual que el backend)

export function hmacHex(secret, data) {
  return createHmac('sha256', secret).update(data).digest('hex');
}

export function canonicalParams(params) {
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join('&');
}

export function signWebhook(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${hmacHex(secret, `${timestamp}.${body}`)}`;
}

/** Verifica "t=<unix>,v1=<hmac>" sobre el cuerpo crudo, con tolerancia de 5 minutos (anti replay). */
export function verifySignedBody(secret, body, header, toleranceSeconds = 300) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? '');
  if (!m) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(m[1])) > toleranceSeconds) return false;
  return safeEqualHex(hmacHex(secret, `${m[1]}.${body}`), m[2]);
}

const cents = (amount) => Math.round(Number(amount) * 100);

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !/^[0-9a-f]+$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** Verifica que la tienda generó estos parámetros (nadie cambió el monto en la URL). */
export function verifyPaymentRequest(secret, query) {
  const params = {};
  for (const k of PARAMS) {
    if (typeof query[k] !== 'string' || query[k] === '') return { ok: false, error: `Falta el parámetro ${k}` };
    params[k] = query[k];
  }
  if (!safeEqualHex(hmacHex(secret, canonicalParams(params)), query.sig)) return { ok: false, error: 'Firma del pedido de pago inválida' };
  if (!/^\d{1,10}\.\d{2}$/.test(params.amount)) return { ok: false, error: 'Monto inválido' };
  if (!/^https?:\/\//.test(params.return)) return { ok: false, error: 'URL de retorno inválida' };
  return { ok: true, params, expired: Number(params.exp) * 1000 < Date.now() };
}

// ------------------------------------------------------------------ HTML

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function page(title, body) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Pasarela simulada</title>
<style>
  :root { color-scheme: light dark; --bg:#f4f5f7; --card:#fff; --fg:#1d2330; --muted:#5f6b7a; --ok:#11763c; --bad:#b42318; --line:#dfe3e8; }
  @media (prefers-color-scheme: dark) { :root { --bg:#12151b; --card:#1b2029; --fg:#e8ebf0; --muted:#9aa5b4; --ok:#4cc38a; --bad:#f97066; --line:#2c3441; } }
  body { margin:0; font:16px/1.5 system-ui, sans-serif; background:var(--bg); color:var(--fg); }
  main { max-width:440px; margin:40px auto; padding:0 16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:24px; }
  .tag { display:inline-block; font-size:12px; letter-spacing:.04em; text-transform:uppercase; color:var(--muted); }
  h1 { font-size:22px; margin:4px 0 16px; }
  .amount { font-size:34px; font-weight:700; margin:8px 0; }
  dl { display:grid; grid-template-columns:auto 1fr; gap:4px 12px; margin:16px 0; color:var(--muted); }
  dd { margin:0; color:var(--fg); overflow-wrap:anywhere; }
  button, select, a.button { font:inherit; border-radius:8px; padding:10px 14px; border:1px solid var(--line); }
  button { cursor:pointer; width:100%; margin-top:8px; }
  .approve { background:var(--ok); color:#fff; border-color:var(--ok); }
  .reject { background:transparent; color:var(--bad); border-color:var(--bad); }
  select { width:100%; background:var(--card); color:var(--fg); }
  .ok { color:var(--ok); } .bad { color:var(--bad); } .muted { color:var(--muted); font-size:14px; }
  a { color:inherit; }
</style></head><body><main><div class="card">${body}</div>
<p class="muted">Pasarela SIMULADA para desarrollo. No se procesa dinero real.</p></main></body></html>`;
}

function paymentPage(p, sig) {
  const hidden = [...PARAMS.map((k) => [k, p[k]]), ['sig', sig]]
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('');
  const options = Object.entries(REJECTIONS)
    .map(([code, label]) => `<option value="${esc(code)}">${esc(label)}</option>`)
    .join('');
  return page(
    'Pagar',
    `<span class="tag">${esc(METHOD_LABELS[p.method] ?? p.method)}</span>
     <h1>Pedido #${esc(p.order)}</h1>
     <div class="amount">$${esc(p.amount)} <span class="muted">${esc(p.currency)}</span></div>
     <dl><dt>Referencia</dt><dd>${esc(p.ref)}</dd><dt>Vence</dt><dd>${esc(new Date(Number(p.exp) * 1000).toLocaleString('es-EC', { timeZone: 'America/Guayaquil' }))}</dd></dl>
     <form method="post" action="/pay/decision">${hidden}
       <input type="hidden" name="decision" value="approve"><button class="approve" type="submit">Aprobar pago</button>
     </form>
     <form method="post" action="/pay/decision">${hidden}
       <input type="hidden" name="decision" value="reject">
       <label class="muted" for="reason">Motivo del rechazo</label>
       <select id="reason" name="reason">${options}</select>
       <button class="reject" type="submit">Rechazar pago</button>
     </form>`,
  );
}

function resultPage(record, note) {
  const approved = record.event.type === 'payment.approved';
  const d = record.event.data;
  return page(
    approved ? 'Pago aprobado' : 'Pago rechazado',
    `<span class="tag">Pedido #${esc(record.order)}</span>
     <h1 class="${approved ? 'ok' : 'bad'}">${approved ? 'Pago aprobado' : 'Pago rechazado'}</h1>
     <div class="amount">$${esc(d.amount)}</div>
     <dl>${approved ? `<dt>Autorización</dt><dd>${esc(d.authorizationCode)}</dd>` : `<dt>Motivo</dt><dd>${esc(d.failureMessage)}</dd>`}
       <dt>Evento</dt><dd>${esc(record.event.id)}</dd><dt>Webhook</dt><dd>${esc(deliveryText(record))}</dd></dl>
     ${note ? `<p class="muted">${esc(note)}</p>` : ''}
     <p><a class="button" href="${esc(record.returnUrl)}">Volver a la tienda</a></p>
     <form method="post" action="/events/${esc(record.event.id)}/resend">
       <button type="submit">Reenviar el mismo webhook (probar idempotencia)</button>
     </form>`,
  );
}

function errorPage(message, status = 400) {
  return [status, page('Error', `<h1 class="bad">No se puede procesar el pago</h1><p>${esc(message)}</p>`)];
}

function deliveryText(record) {
  if (record.delivered) return `entregado (HTTP ${record.lastStatus}, ${record.attempts} intento/s)`;
  if (record.lastStatus) return `pendiente (último HTTP ${record.lastStatus}, ${record.attempts} intento/s)`;
  return record.attempts > 0 ? `pendiente (${record.attempts} intento/s, ${record.lastError ?? ''})` : 'enviando...';
}

// ------------------------------------------------------------------ servidor

export function createPaymentSimulator({ webhookUrl, webhookSecret, log = console }) {
  if (!webhookUrl || !webhookSecret) throw new Error('WEBHOOK_URL y WEBHOOK_SECRET son obligatorios');
  /** ref → registro de la decisión (una sola por referencia, como en una pasarela real). */
  const byRef = new Map();
  const byEvent = new Map();
  /** refundId de la tienda → reverso (idempotencia: el mismo refundId devuelve el mismo reverso). */
  const refunds = new Map();

  /**
   * Reverso de un cobro aprobado. 404 si la referencia no existe o no fue aprobada (el estado vive en
   * memoria: un reinicio del contenedor lo olvida), 422 si supera lo cobrado menos lo ya reversado.
   */
  function refund(body) {
    const { refundId, reference, amount, currency } = body ?? {};
    if (typeof refundId !== 'string' || typeof reference !== 'string' || !/^\d{1,10}\.\d{2}$/.test(String(amount))) {
      return [400, { error: { code: 'INVALID_REQUEST', message: 'refundId, reference y amount (0.00) son obligatorios' } }];
    }
    const previous = refunds.get(refundId);
    if (previous) return [200, previous];
    const payment = byRef.get(reference);
    if (!payment || payment.event.type !== 'payment.approved') {
      return [404, { error: { code: 'PAYMENT_NOT_FOUND', message: 'No hay un cobro aprobado con esa referencia' } }];
    }
    const refunded = [...refunds.values()].filter((r) => r.reference === reference).reduce((s, r) => s + cents(r.amount), 0);
    if (cents(amount) <= 0 || refunded + cents(amount) > cents(payment.event.data.amount)) {
      return [422, { error: { code: 'REFUND_EXCEEDS_PAYMENT', message: 'El reverso supera lo cobrado menos lo ya reversado' } }];
    }
    const record = {
      id: `rf_${randomUUID().replace(/-/g, '')}`,
      status: 'succeeded',
      refundId,
      reference,
      amount: String(amount),
      currency: currency ?? 'USD',
      created: Math.floor(Date.now() / 1000),
    };
    refunds.set(refundId, record);
    return [201, record];
  }

  function buildEvent(params, decision, reason) {
    const approved = decision === 'approve';
    const code = REJECTIONS[reason] ? reason : 'CARD_DECLINED';
    return {
      id: `evt_${randomUUID().replace(/-/g, '')}`,
      type: approved ? 'payment.approved' : 'payment.rejected',
      created: Math.floor(Date.now() / 1000),
      data: {
        reference: params.ref,
        amount: params.amount,
        currency: params.currency,
        method: params.method,
        ...(approved
          ? {
              authorizationCode: String(randomInt(100000, 1000000)),
              ...(params.method === 'card' ? { cardBrand: 'visa', last4: '4242' } : {}),
            }
          : { failureCode: code, failureMessage: REJECTIONS[code] }),
      },
    };
  }

  /** Un intento de entrega. La firma usa una marca de tiempo nueva en cada intento. */
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
      // 2xx = recibido; 4xx = la tienda lo rechazó (reintentar no sirve); 5xx = reintentar.
      record.delivered = res.ok;
      return res.status < 500;
    } catch (error) {
      record.lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  /** Reintentos con backoff en segundo plano (la página de resultado no los espera). */
  async function retryInBackground(record) {
    for (const delay of RETRY_DELAYS_MS) {
      await new Promise((r) => setTimeout(r, delay));
      if (await deliver(record)) return;
    }
    log.error?.(`[paysim] webhook ${record.event.id} no entregado tras ${record.attempts} intentos`);
  }

  async function readForm(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
  }

  const send = (res, status, body, type = 'text/html; charset=utf-8') => {
    res.writeHead(status, { 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
    res.end(body);
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://paysim');
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, '{"status":"ok"}', 'application/json');

      if (req.method === 'GET' && url.pathname === '/events') {
        const list = [...byEvent.values()].map((r) => ({
          event: r.event,
          attempts: r.attempts,
          delivered: r.delivered,
          lastStatus: r.lastStatus ?? null,
          lastResponse: r.lastResponse ?? null,
        }));
        return send(res, 200, JSON.stringify(list, null, 2), 'application/json');
      }

      if (req.method === 'GET' && url.pathname === '/pay') {
        const check = verifyPaymentRequest(webhookSecret, Object.fromEntries(url.searchParams));
        if (!check.ok) return send(res, ...errorPage(check.error));
        const done = byRef.get(check.params.ref);
        if (done) return send(res, 200, resultPage(done, 'Este pago ya se procesó.'));
        if (check.expired) return send(res, ...errorPage('El plazo para pagar venció. Vuelve a la tienda e intenta de nuevo.', 410));
        return send(res, 200, paymentPage(check.params, url.searchParams.get('sig')));
      }

      if (req.method === 'POST' && url.pathname === '/pay/decision') {
        const form = await readForm(req);
        const check = verifyPaymentRequest(webhookSecret, form);
        if (!check.ok) return send(res, ...errorPage(check.error));
        const existing = byRef.get(check.params.ref);
        // Doble clic en "Aprobar": la segunda vez se muestra el resultado, no se cobra de nuevo.
        if (existing) return send(res, 200, resultPage(existing, 'Este pago ya se procesó.'));
        if (check.expired) return send(res, ...errorPage('El plazo para pagar venció.', 410));
        const record = {
          event: buildEvent(check.params, form.decision === 'approve' ? 'approve' : 'reject', form.reason),
          order: check.params.order,
          returnUrl: check.params.return,
          attempts: 0,
          delivered: false,
        };
        byRef.set(check.params.ref, record);
        byEvent.set(record.event.id, record);
        if (!(await deliver(record))) void retryInBackground(record);
        return send(res, 200, resultPage(record));
      }

      if (req.method === 'GET' && url.pathname === '/refunds') {
        return send(res, 200, JSON.stringify([...refunds.values()], null, 2), 'application/json');
      }

      if (req.method === 'POST' && url.pathname === '/refunds') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!verifySignedBody(webhookSecret, raw, req.headers[SIGNATURE_HEADER])) {
          return send(res, 401, JSON.stringify({ error: { code: 'INVALID_SIGNATURE', message: 'Firma inválida o vencida' } }), 'application/json');
        }
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          body = null;
        }
        const [status, payload] = refund(body);
        return send(res, status, JSON.stringify(payload), 'application/json');
      }

      const resend = url.pathname.match(/^\/events\/([A-Za-z0-9_]+)\/resend$/);
      if (req.method === 'POST' && resend) {
        const record = byEvent.get(resend[1]);
        if (!record) return send(res, ...errorPage('Evento desconocido', 404));
        await deliver(record);
        return send(res, 200, resultPage(record, `Reenviado. Respuesta de la tienda: ${record.lastResponse ?? record.lastError ?? ''}`));
      }

      return send(res, 404, page('No encontrado', '<h1>404</h1>'));
    } catch (error) {
      log.error?.(error);
      return send(res, 500, page('Error', '<h1 class="bad">Error interno del simulador</h1>'));
    }
  });
  return { server, events: byEvent, refunds };
}

// Arranque como contenedor.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT ?? 3000);
  const { server } = createPaymentSimulator({ webhookUrl: process.env.WEBHOOK_URL, webhookSecret: process.env.WEBHOOK_SECRET });
  server.listen(port, () => console.log(`[paysim] escuchando en :${port} → webhooks a ${process.env.WEBHOOK_URL}`));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
