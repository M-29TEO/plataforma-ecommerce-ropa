import { SriUnavailableError } from '../../application/ports';
import { authorizationRequest, parseAuthorizationResponse, parseReceptionResponse, receptionRequest } from './sri-soap.adapter';
import { parseXml } from './xml-reader';

const KEY = '2110201101179214673900110020010000000011234567813';
const soap = (body: string) =>
  `<?xml version="1.0" ?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${body}</soap:Body></soap:Envelope>`;

describe('SOAP del SRI', () => {
  test('validarComprobante lleva el XML firmado en base64', () => {
    const req = parseXml(receptionRequest('<factura id="comprobante">ñ</factura>'));
    const xml = req.children[0].children[1].children[0].children[0];
    expect(xml.name).toBe('xml');
    expect(Buffer.from(xml.text, 'base64').toString('utf8')).toBe('<factura id="comprobante">ñ</factura>');
    expect(authorizationRequest(KEY)).toContain(`<claveAccesoComprobante>${KEY}</claveAccesoComprobante>`);
  });

  test('RECIBIDA', () => {
    const xml = soap(
      '<ns2:validarComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.recepcion"><RespuestaRecepcionComprobante><estado>RECIBIDA</estado><comprobantes/></RespuestaRecepcionComprobante></ns2:validarComprobanteResponse>',
    );
    expect(parseReceptionResponse(xml)).toEqual({ status: 'RECIBIDA', messages: [] });
  });

  test('DEVUELTA con sus mensajes', () => {
    const xml = soap(
      '<ns2:validarComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.recepcion"><RespuestaRecepcionComprobante><estado>DEVUELTA</estado><comprobantes><comprobante>' +
        `<claveAcceso>${KEY}</claveAcceso><mensajes><mensaje><identificador>35</identificador><mensaje>ARCHIVO NO CUMPLE ESTRUCTURA XML</mensaje>` +
        '<informacionAdicional>Falta el elemento &lt;importeTotal&gt;</informacionAdicional><tipo>ERROR</tipo></mensaje></mensajes></comprobante></comprobantes>' +
        '</RespuestaRecepcionComprobante></ns2:validarComprobanteResponse>',
    );
    expect(parseReceptionResponse(xml)).toEqual({
      status: 'DEVUELTA',
      messages: [{ identificador: '35', mensaje: 'ARCHIVO NO CUMPLE ESTRUCTURA XML', informacionAdicional: 'Falta el elemento <importeTotal>', tipo: 'ERROR' }],
    });
  });

  test('AUTORIZADO con el comprobante en CDATA', () => {
    const xml = soap(
      '<ns2:autorizacionComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.autorizacion"><RespuestaAutorizacionComprobante>' +
        `<claveAccesoConsultada>${KEY}</claveAccesoConsultada><numeroComprobantes>1</numeroComprobantes><autorizaciones><autorizacion>` +
        `<estado>AUTORIZADO</estado><numeroAutorizacion>${KEY}</numeroAutorizacion><fechaAutorizacion>2026-09-30T10:21:04-05:00</fechaAutorizacion>` +
        '<ambiente>PRUEBAS</ambiente><comprobante><![CDATA[<factura id="comprobante">&amp;</factura>]]></comprobante><mensajes/></autorizacion></autorizaciones>' +
        '</RespuestaAutorizacionComprobante></ns2:autorizacionComprobanteResponse>',
    );
    expect(parseAuthorizationResponse(xml)).toEqual({
      status: 'AUTORIZADO',
      authorizationNumber: KEY,
      authorizedAt: new Date('2026-09-30T15:21:04Z'),
      environment: 'PRUEBAS',
      comprobante: '<factura id="comprobante">&amp;</factura>',
      messages: [],
    });
  });

  test('sin autorizaciones todavía = EN PROCESO; NO AUTORIZADO con mensajes', () => {
    const empty = soap(
      `<RespuestaAutorizacionComprobante><claveAccesoConsultada>${KEY}</claveAccesoConsultada><numeroComprobantes>0</numeroComprobantes><autorizaciones/></RespuestaAutorizacionComprobante>`,
    );
    expect(parseAuthorizationResponse(empty)).toEqual({ status: 'EN PROCESO' });

    const rejected = soap(
      '<RespuestaAutorizacionComprobante><autorizaciones><autorizacion><estado>NO AUTORIZADO</estado><mensajes><mensaje>' +
        '<identificador>39</identificador><mensaje>FIRMA INVALIDA</mensaje><tipo>ERROR</tipo></mensaje></mensajes></autorizacion></autorizaciones></RespuestaAutorizacionComprobante>',
    );
    expect(parseAuthorizationResponse(rejected)).toEqual({
      status: 'NO AUTORIZADO',
      messages: [{ identificador: '39', mensaje: 'FIRMA INVALIDA', informacionAdicional: null, tipo: 'ERROR' }],
    });
  });

  test('una respuesta que no se entiende es transitoria (se reintenta)', () => {
    expect(() => parseReceptionResponse(soap('<otra/>'))).toThrow(SriUnavailableError);
  });
});
