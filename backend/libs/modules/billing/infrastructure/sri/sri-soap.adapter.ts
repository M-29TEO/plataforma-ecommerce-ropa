import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../../../shared-kernel';
import { AuthorizationResult, ReceptionResult, SriPort, SriUnavailableError } from '../../application/ports';
import { SriMessage } from '../../domain/electronic-document';
import { childText, find, findAll, parseXml, XmlNode } from './xml-reader';

export const RECEPTION_PATH = '/comprobantes-electronicos-ws/RecepcionComprobantesOffline';
export const AUTHORIZATION_PATH = '/comprobantes-electronicos-ws/AutorizacionComprobantesOffline';

const envelope = (ns: string, body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="${ns}">` +
  `<soapenv:Header/><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;

export function receptionRequest(signedXml: string): string {
  const b64 = Buffer.from(signedXml, 'utf8').toString('base64');
  return envelope('http://ec.gob.sri.ws.recepcion', `<ec:validarComprobante><xml>${b64}</xml></ec:validarComprobante>`);
}

export function authorizationRequest(accessKey: string): string {
  return envelope(
    'http://ec.gob.sri.ws.autorizacion',
    `<ec:autorizacionComprobante><claveAccesoComprobante>${accessKey}</claveAccesoComprobante></ec:autorizacionComprobante>`,
  );
}

function messages(node: XmlNode | undefined): SriMessage[] {
  if (!node) return [];
  return findAll(node, 'mensaje')
    .filter((m) => m.children.length > 0) // <mensaje> contiene otro <mensaje> con el texto
    .map((m) => ({
      identificador: childText(m, 'identificador') ?? '',
      mensaje: childText(m, 'mensaje') ?? '',
      informacionAdicional: childText(m, 'informacionAdicional') || null,
      tipo: childText(m, 'tipo') ?? 'ERROR',
    }));
}

export function parseReceptionResponse(xml: string): ReceptionResult {
  const resp = find(parseXml(xml), 'RespuestaRecepcionComprobante');
  const estado = resp && childText(resp, 'estado');
  if (estado === 'RECIBIDA') return { status: 'RECIBIDA', messages: messages(find(resp!, 'comprobantes')) };
  if (estado === 'DEVUELTA') return { status: 'DEVUELTA', messages: messages(find(resp!, 'comprobantes')) };
  throw new SriUnavailableError(`Respuesta de recepción desconocida: ${estado ?? 'sin estado'}`, true);
}

export function parseAuthorizationResponse(xml: string): AuthorizationResult {
  const resp = find(parseXml(xml), 'RespuestaAutorizacionComprobante');
  if (!resp) throw new SriUnavailableError('Respuesta de autorización sin RespuestaAutorizacionComprobante', true);
  const all = findAll(resp, 'autorizacion');
  // Si hay varias (reenvíos), manda la autorizada; si no, la última.
  const a = all.find((x) => childText(x, 'estado') === 'AUTORIZADO') ?? all[all.length - 1];
  const estado = a ? childText(a, 'estado') : null;
  if (!a || !estado || estado === 'EN PROCESO' || estado === 'EN PROCESAMIENTO') return { status: 'EN PROCESO' };
  if (estado === 'AUTORIZADO') {
    const number = childText(a, 'numeroAutorizacion');
    const date = childText(a, 'fechaAutorizacion');
    const authorizedAt = date ? new Date(date) : null;
    if (!number || !authorizedAt || Number.isNaN(authorizedAt.getTime())) {
      throw new SriUnavailableError('Autorización sin número o fecha válida', true);
    }
    return {
      status: 'AUTORIZADO',
      authorizationNumber: number,
      authorizedAt,
      environment: childText(a, 'ambiente') ?? '',
      comprobante: (a.children.find((c) => c.name === 'comprobante')?.text ?? '').trim(),
      messages: messages(find(a, 'mensajes')),
    };
  }
  if (estado === 'NO AUTORIZADO') return { status: 'NO AUTORIZADO', messages: messages(find(a, 'mensajes')) };
  throw new SriUnavailableError(`Estado de autorización desconocido: ${estado}`, true);
}

/**
 * Web services offline del SRI (SOAP 1.1): el mismo adaptador sirve para el simulador
 * (SRI_MODE=simulator) y para los ambientes reales de pruebas (celcer) y producción (cel), que
 * solo cambian la URL base. Los errores de red, timeouts, 5xx y SOAP Fault son transitorios
 * (SriUnavailableError) y se reintentan con backoff.
 */
@Injectable()
export class SriSoapAdapter extends SriPort {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    super();
  }

  async send(signedXml: string): Promise<ReceptionResult> {
    return parseReceptionResponse(await this.post(RECEPTION_PATH, receptionRequest(signedXml)));
  }

  async authorize(accessKey: string): Promise<AuthorizationResult> {
    return parseAuthorizationResponse(await this.post(AUTHORIZATION_PATH, authorizationRequest(accessKey)));
  }

  private async post(path: string, body: string): Promise<string> {
    const url = `${this.config.billing.sriUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: '""' },
        body,
        signal: AbortSignal.timeout(this.config.billing.sriTimeoutMs),
      });
    } catch (error) {
      // Por nombre y no con instanceof: el DOMException del abort no siempre es instancia del Error del contexto.
      const { name, message } = (error ?? {}) as { name?: string; message?: string };
      const timeout = name === 'TimeoutError' || name === 'AbortError';
      throw new SriUnavailableError(`SRI no respondió (${url}): ${message ?? String(error)}`, timeout);
    }
    const text = await res.text().catch(() => '');
    if (!res.ok || /<(\w+:)?Fault[\s>]/.test(text)) {
      // El SRI contestó con error: no aceptó el comprobante (no queda "quizá recibido").
      throw new SriUnavailableError(`SRI respondió ${res.status} en ${path}`, false);
    }
    return text;
  }
}
