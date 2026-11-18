// SRI SIMULADO (ADR-10). Imita los web services OFFLINE de comprobantes electrónicos del SRI de
// Ecuador (SOAP 1.1), con las mismas rutas, operaciones y respuestas que celcer.sri.gob.ec:
//
//   POST RECEPTION_PATH        validarComprobante(xml en base64): factura (01) o nota de crédito (04)
//        → RECIBIDA, o DEVUELTA con mensajes si el XML no cumple la ficha técnica (o la nota de
//          crédito modifica una factura no autorizada o supera su total).
//   POST AUTHORIZATION_PATH    autorizacionComprobante(claveAccesoComprobante)
//        → sin autorizaciones mientras procesa (authDelayMs), luego AUTORIZADO con el
//          comprobante en CDATA, o NO AUTORIZADO si la firma no verifica o los totales no cuadran.
//
// Consola (red de desarrollo, sin credenciales):
//   GET  /admin/comprobantes · GET /admin/comprobantes/:clave (con el XML)
//   GET  /admin/config · POST /admin/config      authDelayMs, latencyMs, failRate, consumerFinalMax
//   POST /admin/reset                            olvida todos los comprobantes
//   GET  /health
// Sin dependencias: solo Node. El estado vive en memoria.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { ERRORS, identity, message, signatureErrors, structureErrors, totalErrors } from './rules.mjs';
import { child, parseXml, textOf, walk, XmlError } from './xml.mjs';

export const RECEPTION_PATH = '/comprobantes-electronicos-ws/RecepcionComprobantesOffline';
export const AUTHORIZATION_PATH = '/comprobantes-electronicos-ws/AutorizacionComprobantesOffline';
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export const DEFAULT_CONFIG = {
  /** Tiempo que el SRI "procesa" un comprobante recibido antes de autorizarlo. */
  authDelayMs: 3_000,
  /** Demora artificial de cada respuesta (probar el timeout del backend). */
  latencyMs: 0,
  /** Probabilidad [0, 1] de responder 503 (probar el backoff del backend). */
  failRate: 0,
  /** Máximo de una factura a consumidor final en USD; 0 = sin límite. */
  consumerFinalMax: 50,
};

// ------------------------------------------------------------------ SOAP

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const envelope = (body) =>
  `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${body}</soap:Body></soap:Envelope>`;
const mensajesXml = (list) =>
  list
    .map(
      (m) =>
        `<mensaje><identificador>${esc(m.identificador)}</identificador><mensaje>${esc(m.mensaje)}</mensaje>` +
        (m.informacionAdicional ? `<informacionAdicional>${esc(m.informacionAdicional)}</informacionAdicional>` : '') +
        `<tipo>${esc(m.tipo)}</tipo></mensaje>`,
    )
    .join('');

export function receptionResponse(estado, claveAcceso = null, mensajes = []) {
  const comprobantes = mensajes.length
    ? `<comprobantes><comprobante><claveAcceso>${esc(claveAcceso ?? '')}</claveAcceso><mensajes>${mensajesXml(mensajes)}</mensajes></comprobante></comprobantes>`
    : '<comprobantes/>';
  return envelope(
    `<ns2:validarComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.recepcion"><RespuestaRecepcionComprobante><estado>${estado}</estado>${comprobantes}</RespuestaRecepcionComprobante></ns2:validarComprobanteResponse>`,
  );
}

function authorizationResponse(clave, record) {
  let autorizaciones = '';
  if (record?.estado === 'AUTORIZADO' || record?.estado === 'NO AUTORIZADO') {
    const ambiente = record.ambiente === '2' ? 'PRODUCCIÓN' : 'PRUEBAS';
    autorizaciones =
      `<autorizacion><estado>${record.estado}</estado>` +
      (record.estado === 'AUTORIZADO' ? `<numeroAutorizacion>${clave}</numeroAutorizacion>` : '') +
      `<fechaAutorizacion>${ecuadorDateTime(record.decidedAt)}</fechaAutorizacion><ambiente>${ambiente}</ambiente>` +
      `<comprobante><![CDATA[${record.xml.split(']]>').join(']]]]><![CDATA[>')}]]></comprobante>` +
      `<mensajes>${mensajesXml(record.mensajes)}</mensajes></autorizacion>`;
  }
  const n = autorizaciones ? 1 : 0;
  return envelope(
    `<ns2:autorizacionComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.autorizacion"><RespuestaAutorizacionComprobante>` +
      `<claveAccesoConsultada>${esc(clave)}</claveAccesoConsultada><numeroComprobantes>${n}</numeroComprobantes>` +
      `<autorizaciones>${autorizaciones}</autorizaciones></RespuestaAutorizacionComprobante></ns2:autorizacionComprobanteResponse>`,
  );
}

/** 2026-09-30T10:21:04-05:00 (Ecuador continental, UTC−5 todo el año). */
export function ecuadorDateTime(d) {
  return `${new Date(d.getTime() - 5 * 3600_000).toISOString().slice(0, 19)}-05:00`;
}

/** Valor de un elemento del Body SOAP por nombre local (xml, claveAccesoComprobante). */
function soapParam(body, local) {
  const env = parseXml(body);
  for (const n of walk(env)) if (n.local === local) return textOf(n).trim();
  return null;
}

// ------------------------------------------------------------------ simulador

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {{ config?: Partial<typeof DEFAULT_CONFIG>, now?: () => Date, random?: () => number, log?: Console }} opts
 */
export function createSriSimulator(opts = {}) {
  const settings = { ...DEFAULT_CONFIG, ...(opts.config ?? {}) };
  const now = opts.now ?? (() => new Date());
  const random = opts.random ?? Math.random;
  const log = opts.log ?? console;
  /** claveAcceso → { xml, estado: RECIBIDA|AUTORIZADO|NO AUTORIZADO, ambiente, serie, receivedAt, decidedAt, mensajes } */
  const comprobantes = new Map();
  /** serie (ruc-codDoc-estab-ptoEmi-secuencial) → claveAcceso */
  const series = new Map();

  function receive(xml) {
    let root;
    try {
      root = parseXml(xml);
    } catch (error) {
      return { estado: 'DEVUELTA', clave: null, mensajes: [message(ERRORS.ESTRUCTURA, error instanceof XmlError ? error.message : 'XML mal formado')] };
    }
    const id = root.local === 'factura' || root.local === 'notaCredito' ? identity(root) : { claveAcceso: null };
    const clave = id.claveAcceso;
    const existing = clave && comprobantes.get(clave);
    if (existing) {
      const code = existing.estado === 'RECIBIDA' ? ERRORS.EN_PROCESAMIENTO : ERRORS.CLAVE_REGISTRADA;
      return { estado: 'DEVUELTA', clave, mensajes: [message(code)] };
    }
    const errors = structureErrors(root, { consumerFinalMax: settings.consumerFinalMax });
    if (errors.length) return { estado: 'DEVUELTA', clave, mensajes: errors.map((e) => message(ERRORS.ESTRUCTURA, e)) };
    if (!child(root, 'Signature')) {
      return { estado: 'DEVUELTA', clave, mensajes: [message(ERRORS.FIRMA, 'El comprobante no está firmado (falta ds:Signature)')] };
    }
    const owner = series.get(id.serie);
    if (owner && owner !== clave) {
      return { estado: 'DEVUELTA', clave, mensajes: [message(ERRORS.SECUENCIAL, `El secuencial ya se usó en la clave ${owner}`)] };
    }
    const modificado = id.modifica ? creditNoteErrors(id) : null;
    if (modificado) return { estado: 'DEVUELTA', clave, mensajes: [message(ERRORS.ESTRUCTURA, modificado)] };
    comprobantes.set(clave, {
      xml,
      estado: 'RECIBIDA',
      ambiente: id.ambiente,
      serie: id.serie,
      total: id.total ?? null,
      modifica: id.modifica ?? null,
      valor: id.valor ?? 0,
      receivedAt: now(),
      decidedAt: null,
      mensajes: [],
      root,
    });
    series.set(id.serie, clave);
    return { estado: 'RECIBIDA', clave, mensajes: [] };
  }

  /**
   * Una nota de crédito debe modificar una factura AUTORIZADA y, sumada a las notas de crédito
   * vigentes sobre ella, no superar su total. Si la factura no está en memoria (el simulador se
   * reinició), se acepta: no hay con qué comparar.
   */
  function creditNoteErrors(id) {
    const facturaClave = series.get(id.modifica);
    const factura = facturaClave && comprobantes.get(facturaClave);
    if (!factura) return null;
    if (factura.estado !== 'AUTORIZADO') return `El documento modificado ${id.modifica} no está autorizado (${factura.estado})`;
    const acreditado = [...comprobantes.values()]
      .filter((c) => c.modifica === id.modifica && c.estado !== 'NO AUTORIZADO')
      .reduce((s, c) => s + c.valor, 0);
    if (acreditado + id.valor > factura.total) {
      return `El valor de las notas de crédito (${((acreditado + id.valor) / 100).toFixed(2)}) supera el total del documento modificado (${(factura.total / 100).toFixed(2)})`;
    }
    return null;
  }

  /** Al consultar, un comprobante recibido hace más de authDelayMs se autoriza o se rechaza. */
  function decide(record) {
    if (record.estado !== 'RECIBIDA' || now().getTime() - record.receivedAt.getTime() < settings.authDelayMs) return;
    const firma = signatureErrors(record.root, now()).map((e) => message(ERRORS.FIRMA, e));
    const totales = firma.length ? [] : totalErrors(record.root).map((e) => message(ERRORS.DIFERENCIAS, e));
    const mensajes = [...firma, ...totales];
    record.estado = mensajes.length ? 'NO AUTORIZADO' : 'AUTORIZADO';
    record.mensajes = mensajes;
    record.decidedAt = now();
    delete record.root;
    // Un NO AUTORIZADO libera el secuencial: el emisor debe emitir con otra clave.
    if (record.estado === 'NO AUTORIZADO') series.delete(record.serie);
    log.info?.(`[srisim] ${record.serie} → ${record.estado}${mensajes.length ? `: ${mensajes.map((m) => m.informacionAdicional).join('; ')}` : ''}`);
  }

  const view = (clave, r, withXml = false) => ({
    claveAcceso: clave,
    estado: r.estado,
    serie: r.serie,
    receivedAt: r.receivedAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
    mensajes: r.mensajes,
    ...(withXml ? { xml: r.xml } : {}),
  });

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Cuerpo demasiado grande');
      chunks.push(c);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  const send = (res, status, type, body) => res.writeHead(status, { 'content-type': type }).end(body);
  const json = (res, status, body) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(body));
  const xmlReply = (res, body) => send(res, 200, 'text/xml; charset=utf-8', body);

  async function chaos() {
    if (settings.latencyMs > 0) await new Promise((r) => setTimeout(r, settings.latencyMs));
    if (settings.failRate > 0 && random() < settings.failRate) throw new HttpError(503, 'Servicio no disponible (simulado)');
  }

  async function route(req, res, url) {
    const path = url.pathname;
    if (req.method === 'GET' && path === '/health') return json(res, 200, { status: 'ok' });

    if (req.method === 'POST' && path === RECEPTION_PATH) {
      const body = await readBody(req);
      await chaos();
      let b64;
      try {
        b64 = soapParam(body, 'xml');
      } catch {
        throw new HttpError(400, 'SOAP mal formado');
      }
      if (!b64) throw new HttpError(400, 'Falta el parámetro xml de validarComprobante');
      const r = receive(Buffer.from(b64, 'base64').toString('utf8'));
      log.info?.(`[srisim] recepción ${r.clave ?? '(sin clave)'} → ${r.estado}`);
      return xmlReply(res, receptionResponse(r.estado, r.clave, r.mensajes));
    }

    if (req.method === 'POST' && path === AUTHORIZATION_PATH) {
      const body = await readBody(req);
      await chaos();
      let clave;
      try {
        clave = soapParam(body, 'claveAccesoComprobante');
      } catch {
        throw new HttpError(400, 'SOAP mal formado');
      }
      const record = clave ? comprobantes.get(clave) : null;
      if (record) decide(record);
      return xmlReply(res, authorizationResponse(clave ?? '', record));
    }

    if (req.method === 'GET' && path === '/admin/comprobantes') {
      for (const r of comprobantes.values()) decide(r);
      return json(res, 200, [...comprobantes].map(([k, r]) => view(k, r)));
    }
    const one = path.match(/^\/admin\/comprobantes\/(\d{49})$/);
    if (req.method === 'GET' && one) {
      const r = comprobantes.get(one[1]);
      if (!r) throw new HttpError(404, 'Clave de acceso desconocida');
      decide(r);
      return json(res, 200, view(one[1], r, true));
    }
    if (path === '/admin/config') {
      if (req.method === 'GET') return json(res, 200, settings);
      if (req.method === 'POST') {
        let patch;
        try {
          patch = JSON.parse((await readBody(req)) || '{}');
        } catch {
          throw new HttpError(400, 'JSON inválido');
        }
        for (const [k, v] of Object.entries(patch)) {
          if (!(k in DEFAULT_CONFIG) || typeof v !== 'number' || v < 0) throw new HttpError(400, `Parámetro inválido: ${k}`);
          settings[k] = v;
        }
        return json(res, 200, settings);
      }
    }
    if (req.method === 'POST' && path === '/admin/reset') {
      comprobantes.clear();
      series.clear();
      return json(res, 200, { ok: true });
    }
    throw new HttpError(404, 'Ruta no encontrada');
  }

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res, new URL(req.url ?? '/', 'http://srisim'));
    } catch (error) {
      if (error instanceof HttpError) {
        // Como el SRI real: los errores de servicio son SOAP Fault.
        const fault = envelope(`<soap:Fault><faultcode>soap:Server</faultcode><faultstring>${esc(error.message)}</faultstring></soap:Fault>`);
        return send(res, error.status, 'text/xml; charset=utf-8', fault);
      }
      log.error?.(error);
      return send(res, 500, 'text/plain; charset=utf-8', 'Error interno del simulador');
    }
  });
  return { server, comprobantes, settings };
}

// Arranque como contenedor.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT ?? 3000);
  const num = (name) => (process.env[name] !== undefined && process.env[name] !== '' ? Number(process.env[name]) : undefined);
  const config = Object.fromEntries(
    Object.entries({
      authDelayMs: num('AUTH_DELAY_MS'),
      latencyMs: num('LATENCY_MS'),
      failRate: num('FAIL_RATE'),
      consumerFinalMax: num('CONSUMIDOR_FINAL_MAX'),
    }).filter(([, v]) => v !== undefined),
  );
  const { server, settings } = createSriSimulator({ config });
  server.listen(port, () => console.log(`[srisim] SRI simulado en :${port}`, settings));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

