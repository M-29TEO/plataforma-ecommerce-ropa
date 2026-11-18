/**
 * SRI falso para los tests de integración de Facturación y Devoluciones: mismas rutas y respuestas
 * SOAP que el SRI (y que simulators/sri), sin validar el comprobante. Lo comparten los archivos de test.
 */
import http from 'node:http';

// ------------------------------------------------------------------ SRI falso (SOAP offline)

export type ReceptionMode = 'ok' | 'devuelta' | 'timeout' | 'down';

/** Estado del SRI falso: cada test lo ajusta (modo de recepción, consultas pendientes, autorización). */
export const sri = {
  reception: 'ok' as ReceptionMode,
  /** Consultas que responden "sin autorizaciones todavía" antes de AUTORIZADO. */
  pendingPolls: 1,
  authorization: 'ok' as 'ok' | 'no_autorizado',
  received: new Map<string, { xml: string; polls: number }>(),
  receptionCalls: 0,
};

const soap = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${body}</soap:Body></soap:Envelope>`;
const reception = (estado: string, mensajes = '') =>
  soap(
    `<ns2:validarComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.recepcion"><RespuestaRecepcionComprobante><estado>${estado}</estado>` +
      `<comprobantes>${mensajes}</comprobantes></RespuestaRecepcionComprobante></ns2:validarComprobanteResponse>`,
  );
const mensaje = (id: string, texto: string, info = '') =>
  `<comprobante><mensajes><mensaje><identificador>${id}</identificador><mensaje>${texto}</mensaje><informacionAdicional>${info}</informacionAdicional><tipo>ERROR</tipo></mensaje></mensajes></comprobante>`;

/** Servidor SOAP que imita la recepción y la autorización offline del SRI (factura o nota de crédito). */
export function fakeSri(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const reply = (xml: string, status = 200) => res.writeHead(status, { 'content-type': 'text/xml; charset=utf-8' }).end(xml);
      if (req.url?.endsWith('/RecepcionComprobantesOffline')) {
        sri.receptionCalls++;
        const xml = Buffer.from(/<xml>([^<]+)<\/xml>/.exec(body)![1], 'base64').toString('utf8');
        const key = /<claveAcceso>(\d{49})<\/claveAcceso>/.exec(xml)![1];
        if (sri.reception === 'down') return reply('<html>502</html>', 502);
        if (sri.reception === 'devuelta') return reply(reception('DEVUELTA', mensaje('35', 'ARCHIVO NO CUMPLE ESTRUCTURA XML', 'Identificación del comprador inválida')));
        if (sri.received.has(key)) return reply(reception('DEVUELTA', mensaje('43', 'CLAVE ACCESO REGISTRADA')));
        sri.received.set(key, { xml, polls: 0 });
        // Timeout: el SRI lo recibe, pero la respuesta llega después de SRI_TIMEOUT_MS.
        if (sri.reception === 'timeout') return void setTimeout(() => reply(reception('RECIBIDA')), 1_500).unref();
        return reply(reception('RECIBIDA'));
      }
      if (req.url?.endsWith('/AutorizacionComprobantesOffline')) {
        const key = /<claveAccesoComprobante>(\d{49})</.exec(body)![1];
        const rec = sri.received.get(key);
        const empty = `<RespuestaAutorizacionComprobante><claveAccesoConsultada>${key}</claveAccesoConsultada><numeroComprobantes>0</numeroComprobantes><autorizaciones/></RespuestaAutorizacionComprobante>`;
        if (!rec || rec.polls++ < sri.pendingPolls) return reply(soap(empty));
        const autorizacion =
          sri.authorization === 'no_autorizado'
            ? '<estado>NO AUTORIZADO</estado><mensajes><mensaje><identificador>39</identificador><mensaje>FIRMA INVALIDA</mensaje><tipo>ERROR</tipo></mensaje></mensajes>'
            : `<estado>AUTORIZADO</estado><numeroAutorizacion>${key}</numeroAutorizacion><fechaAutorizacion>2026-09-30T10:21:04-05:00</fechaAutorizacion>` +
              `<ambiente>PRUEBAS</ambiente><comprobante><![CDATA[${rec.xml}]]></comprobante><mensajes/>`;
        return reply(
          soap(
            `<ns2:autorizacionComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.autorizacion"><RespuestaAutorizacionComprobante><claveAccesoConsultada>${key}</claveAccesoConsultada>` +
              `<numeroComprobantes>1</numeroComprobantes><autorizaciones><autorizacion>${autorizacion}</autorizacion></autorizaciones></RespuestaAutorizacionComprobante></ns2:autorizacionComprobanteResponse>`,
          ),
        );
      }
      reply('', 404);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
