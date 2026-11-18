// node --test: C14N, reglas de la ficha técnica, firma XAdES y el flujo SOAP de recepción y
// autorización. fixtures/ tiene facturas firmadas por el BACKEND (npm run -s sri:sample): así se
// verifica que el simulador acepta la firma real del proyecto con una implementación distinta.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';
import { isValidAccessKey, isValidCedula, isValidRuc, mod11, signatureErrors, structureErrors, totalErrors } from './rules.mjs';
import { AUTHORIZATION_PATH, createSriSimulator, RECEPTION_PATH } from './server.mjs';
import { canonicalize, parseXml, XmlError } from './xml.mjs';

const SIGNED = readFileSync(new URL('./fixtures/factura-firmada.xml', import.meta.url), 'utf8');
const BAD_TOTALS = readFileSync(new URL('./fixtures/factura-totales-mal.xml', import.meta.url), 'utf8');
const KEY = /<claveAcceso>(\d{49})<\/claveAcceso>/.exec(SIGNED)[1];
const CREDIT_NOTE = readFileSync(new URL('./fixtures/nota-credito-firmada.xml', import.meta.url), 'utf8');
const NC_KEY = /<claveAcceso>(\d{49})<\/claveAcceso>/.exec(CREDIT_NOTE)[1];
const unsigned = (xml) =>xml.replace(/<ds:Signature[\s\S]*<\/ds:Signature>/, '');

describe('Canonical XML 1.0', () => {
  test('atributos ordenados, <a/> expandido, escapes y espacios de nombres heredados en el apex', () => {
    const root = parseXml('<?xml version="1.0"?><r xmlns:b="urn:b" z="1" a="&lt;&quot;"><b:x/><!-- c --><y>1 &amp; 2 &gt;</y></r>');
    assert.equal(canonicalize(root), '<r xmlns:b="urn:b" a="&lt;&quot;" z="1"><b:x></b:x><y>1 &amp; 2 &gt;</y></r>');
    const x = root.children[0];
    assert.equal(canonicalize(x), '<b:x xmlns:b="urn:b"></b:x>');
  });

  test('las declaraciones repetidas en descendientes no se vuelven a escribir; enveloped excluye el nodo', () => {
    const root = parseXml('<r xmlns:a="urn:a"><a:s xmlns:a="urn:a"><a:t>v</a:t></a:s><k>1</k></r>');
    assert.equal(canonicalize(root), '<r xmlns:a="urn:a"><a:s><a:t>v</a:t></a:s><k>1</k></r>');
    assert.equal(canonicalize(root, root.children[0]), '<r xmlns:a="urn:a"><k>1</k></r>');
  });

  test('rechaza XML mal formado y DTD', () => {
    assert.throws(() => parseXml('<a><b></a>'), XmlError);
    assert.throws(() => parseXml('<!DOCTYPE a><a/>'), XmlError);
    assert.throws(() => parseXml('<a x="1" x="2"/>'), XmlError);
  });
});

describe('reglas', () => {
  test('clave de acceso: módulo 11 con casos conocidos', () => {
    assert.equal(mod11('41261533'), 6);
    assert.ok(isValidAccessKey('2110201101179214673900110020010000000011234567813'));
    assert.ok(!isValidAccessKey('2110201101179214673900110020010000000011234567814'));
    assert.ok(isValidAccessKey(KEY));
  });

  test('cédula y RUC', () => {
    assert.ok(isValidCedula('1710034065'));
    assert.ok(!isValidCedula('1712345678'));
    assert.ok(isValidRuc('1790000000001'));
    assert.ok(!isValidRuc('1710034065000'));
  });

  test('la factura firmada por el backend cumple la estructura, la firma y los totales', () => {
    const root = parseXml(SIGNED);
    assert.deepEqual(structureErrors(root, { consumerFinalMax: 50 }), []);
    assert.deepEqual(signatureErrors(root, new Date('2026-09-30T16:00:00Z')), []);
    assert.deepEqual(totalErrors(root), []);
  });

  test('estructura: campos faltantes, formatos, clave que no coincide y comprador inválido', () => {
    const errs = (xml) => structureErrors(parseXml(xml), { consumerFinalMax: 50 });
    assert.ok(errs(SIGNED.replace(/<importeTotal>[^<]*<\/importeTotal>/, '')).includes('Falta <importeTotal>'));
    assert.ok(errs(SIGNED.replace('<secuencial>000000001</secuencial>', '<secuencial>1</secuencial>')).some((e) => e.includes('<secuencial>')));
    assert.ok(errs(SIGNED.replace('<secuencial>000000001</secuencial>', '<secuencial>000000002</secuencial>')).some((e) => e.includes('no coincide')));
    assert.ok(errs(SIGNED.replace('<identificacionComprador>1710034065', '<identificacionComprador>1712345678')).includes('Cédula del comprador inválida'));
    assert.ok(errs(SIGNED.replace('version="2.1.0"', 'version="3.0.0"')).some((e) => e.includes('Versión')));
  });

  test('consumidor final: 9999999999999 y máximo configurable (0 = sin límite)', () => {
    const cf = SIGNED.replace('<tipoIdentificacionComprador>05', '<tipoIdentificacionComprador>07').replace(
      '<identificacionComprador>1710034065',
      '<identificacionComprador>9999999999999',
    );
    assert.ok(structureErrors(parseXml(cf), { consumerFinalMax: 50 }).some((e) => e.includes('consumidor final no puede superar USD 50.00')));
    assert.deepEqual(structureErrors(parseXml(cf), { consumerFinalMax: 0 }), []);
    assert.deepEqual(structureErrors(parseXml(cf), { consumerFinalMax: 100 }), []);
  });

  test('firma: contenido alterado, SignatureValue alterado, sin firma y certificado vencido', () => {
    const tampered = parseXml(SIGNED.replace('<razonSocialComprador>Ana Pérez', '<razonSocialComprador>Ana Perez'));
    assert.deepEqual(signatureErrors(tampered), ['El digest de #comprobante no coincide: el contenido firmado fue modificado']);
    const badValue = parseXml(SIGNED.replace(/(<ds:SignatureValue[^>]*>)(.)/, (_, tag, c) => `${tag}${c === 'A' ? 'B' : 'A'}`));
    assert.ok(signatureErrors(badValue).some((e) => e.includes('SignatureValue')));
    assert.deepEqual(signatureErrors(parseXml(unsigned(SIGNED))), ['El comprobante no está firmado (falta ds:Signature)']);
    assert.ok(signatureErrors(parseXml(SIGNED), new Date('2040-01-01')).some((e) => e.includes('vigencia')));
  });

  test('la nota de crédito firmada por el backend cumple la estructura, la firma y los totales', () => {
    const root = parseXml(CREDIT_NOTE);
    assert.deepEqual(structureErrors(root, { consumerFinalMax: 50 }), []);
    assert.deepEqual(signatureErrors(root, new Date('2026-09-30T16:00:00Z')), []);
    assert.deepEqual(totalErrors(root), []);
  });

  test('nota de crédito: documento modificado, motivo, consumidor final y valorModificacion', () => {
    const errs = (xml) => structureErrors(parseXml(xml), { consumerFinalMax: 50 });
    assert.ok(errs(CREDIT_NOTE.replace(/<motivo>[^<]*<\/motivo>/, '')).includes('Falta <motivo>'));
    assert.ok(errs(CREDIT_NOTE.replace('<numDocModificado>001-001-000000001', '<numDocModificado>1-1-1')).some((e) => e.includes('numDocModificado')));
    assert.ok(errs(CREDIT_NOTE.replace('<codDoc>04</codDoc>', '<codDoc>01</codDoc>')).some((e) => e.includes('<codDoc>')));
    const cf = CREDIT_NOTE.replace('<tipoIdentificacionComprador>05', '<tipoIdentificacionComprador>07').replace(
      '<identificacionComprador>1710034065',
      '<identificacionComprador>9999999999999',
    );
    assert.ok(errs(cf).includes('Una nota de crédito no puede emitirse a consumidor final'));
    const bad = parseXml(CREDIT_NOTE.replace('<valorModificacion>21.85</valorModificacion>', '<valorModificacion>25.00</valorModificacion>'));
    assert.deepEqual(totalErrors(bad), ['valorModificacion ≠ totalSinImpuestos + impuestos']);
  });

  test('totales: firmada correctamente pero con importeTotal que no cuadra', () => {
    const root = parseXml(BAD_TOTALS);
    assert.deepEqual(signatureErrors(root, new Date('2026-09-30T16:00:00Z')), []);
    assert.deepEqual(totalErrors(root), ['importeTotal ≠ totalSinImpuestos + impuestos + propina', 'La suma de <pagos> no es igual al importeTotal']);
  });
});

describe('web services SOAP', () => {
  let sim;
  let base;
  let clock;
  const soap = (ns, body) =>
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="${ns}"><soapenv:Header/><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'text/xml' }, body }).then(async (r) => ({ status: r.status, text: await r.text() }));
  const send = (xml) =>
    post(RECEPTION_PATH, soap('http://ec.gob.sri.ws.recepcion', `<ec:validarComprobante><xml>${Buffer.from(xml).toString('base64')}</xml></ec:validarComprobante>`));
  const authorize = (key) =>
    post(AUTHORIZATION_PATH, soap('http://ec.gob.sri.ws.autorizacion', `<ec:autorizacionComprobante><claveAccesoComprobante>${key}</claveAccesoComprobante></ec:autorizacionComprobante>`));
  const tag = (xml, name) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];

  before(async () => {
    clock = new Date('2026-09-30T15:30:00Z');
    sim = createSriSimulator({ now: () => clock, log: {}, config: { authDelayMs: 3_000 } });
    await new Promise((r) => sim.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${sim.server.address().port}`;
  });
  beforeEach(async () => {
    await fetch(`${base}/admin/reset`, { method: 'POST' });
    Object.assign(sim.settings, { failRate: 0, latencyMs: 0, consumerFinalMax: 50 });
  });
  after(() => {
    sim.server.closeAllConnections?.();
    return new Promise((r) => sim.server.close(r));
  });

  test('RECIBIDA → sin autorizaciones mientras procesa → AUTORIZADO con el comprobante en CDATA', async () => {
    const r = await send(SIGNED);
    assert.equal(r.status, 200);
    assert.equal(tag(r.text, 'estado'), 'RECIBIDA');

    let a = await authorize(KEY);
    assert.equal(tag(a.text, 'numeroComprobantes'), '0');

    clock = new Date(clock.getTime() + 3_000);
    a = await authorize(KEY);
    assert.equal(tag(a.text, 'estado'), 'AUTORIZADO');
    assert.equal(tag(a.text, 'numeroAutorizacion'), KEY);
    assert.equal(tag(a.text, 'fechaAutorizacion'), '2026-09-30T10:30:03-05:00');
    assert.equal(tag(a.text, 'ambiente'), 'PRUEBAS');
    assert.ok(a.text.includes(`<comprobante><![CDATA[${SIGNED}]]></comprobante>`));
  });

  test('reenvío: EN PROCESAMIENTO (70) mientras procesa y CLAVE ACCESO REGISTRADA (43) después', async () => {
    await send(SIGNED);
    assert.equal(tag((await send(SIGNED)).text, 'identificador'), '70');
    clock = new Date(clock.getTime() + 5_000);
    await authorize(KEY);
    const again = await send(SIGNED);
    assert.equal(tag(again.text, 'estado'), 'DEVUELTA');
    assert.equal(tag(again.text, 'identificador'), '43');
  });

  test('DEVUELTA (35) si el XML no cumple la ficha técnica; se puede reenviar corregido con la misma clave', async () => {
    const r = await send(SIGNED.replace('<identificacionComprador>1710034065', '<identificacionComprador>1712345678'));
    assert.equal(tag(r.text, 'estado'), 'DEVUELTA');
    assert.equal(tag(r.text, 'identificador'), '35');
    assert.equal(tag(r.text, 'claveAcceso'), KEY);
    assert.equal(tag(r.text, 'informacionAdicional'), 'Cédula del comprador inválida');
    assert.equal(tag((await send(SIGNED)).text, 'estado'), 'RECIBIDA');
  });

  test('DEVUELTA (39) si no está firmado; XML ilegible = 35', async () => {
    assert.equal(tag((await send(unsigned(SIGNED))).text, 'identificador'), '39');
    assert.equal(tag((await send('<factura>')).text, 'identificador'), '35');
  });

  test('NO AUTORIZADO (39) si la firma no verifica y (52) si los totales no cuadran', async () => {
    const tampered = SIGNED.replace('<razonSocialComprador>Ana Pérez', '<razonSocialComprador>Ana Perez');
    assert.equal(tag((await send(tampered)).text, 'estado'), 'RECIBIDA');
    assert.equal(tag((await send(BAD_TOTALS)).text, 'estado'), 'RECIBIDA');
    clock = new Date(clock.getTime() + 3_000);

    const a = await authorize(KEY);
    assert.equal(tag(a.text, 'estado'), 'NO AUTORIZADO');
    assert.equal(tag(a.text, 'identificador'), '39');
    assert.equal(tag(a.text, 'numeroAutorizacion'), undefined);

    const b = await authorize(/<claveAcceso>(\d{49})</.exec(BAD_TOTALS)[1]);
    assert.equal(tag(b.text, 'estado'), 'NO AUTORIZADO');
    assert.equal(tag(b.text, 'identificador'), '52');
  });

  test('SECUENCIAL REGISTRADO (45): mismo secuencial con otra clave de acceso', async () => {
    await send(SIGNED);
    // Otro código numérico (y su dígito verificador) = otra clave, mismo secuencial.
    const first48 = `${KEY.slice(0, 39)}87654321${KEY[47]}`;
    const other = first48 + String(mod11(first48));
    const r = await send(unsigned(SIGNED).replace(KEY, other));
    // Sin firma: el secuencial se revisa después de la estructura y la firma → primero 39.
    assert.equal(tag(r.text, 'identificador'), '39');
    const signedOther = SIGNED.replace(KEY, other); // firma rota, pero la recepción no la verifica
    assert.equal(tag((await send(signedOther)).text, 'identificador'), '45');
  });

  test('nota de crédito: exige la factura AUTORIZADA y no puede superar su total', async () => {
    await send(SIGNED);
    // La factura está en proceso: la nota de crédito que la modifica se devuelve.
    let r = await send(CREDIT_NOTE);
    assert.equal(tag(r.text, 'estado'), 'DEVUELTA');
    assert.match(tag(r.text, 'informacionAdicional'), /no está autorizado/);

    clock = new Date(clock.getTime() + 3_000);
    assert.equal(tag((await authorize(KEY)).text, 'estado'), 'AUTORIZADO');
    r = await send(CREDIT_NOTE);
    assert.equal(tag(r.text, 'estado'), 'RECIBIDA');
    clock = new Date(clock.getTime() + 3_000);
    const a = await authorize(NC_KEY);
    assert.equal(tag(a.text, 'estado'), 'AUTORIZADO');
    assert.ok(a.text.includes('<notaCredito id="comprobante"'));

    // Otra nota de crédito (secuencial 2) por 60.00: 21.85 + 60.00 supera los 76.70 de la factura.
    // La recepción no verifica la firma (eso es en la autorización), así que basta con rehacer la clave.
    const first48 = `${NC_KEY.slice(0, 30)}000000002${NC_KEY.slice(39, 48)}`;
    const key2 = first48 + String(mod11(first48));
    const second = CREDIT_NOTE.replace(NC_KEY, key2)
      .replace('<secuencial>000000001</secuencial>', '<secuencial>000000002</secuencial>')
      .replace('<valorModificacion>21.85</valorModificacion>', '<valorModificacion>60.00</valorModificacion>');
    r = await send(second);
    assert.equal(tag(r.text, 'estado'), 'DEVUELTA');
    assert.match(tag(r.text, 'informacionAdicional'), /supera el total del documento modificado/);
  });

  test('nota de crédito sobre una factura desconocida (simulador reiniciado): se acepta', async () => {
    assert.equal(tag((await send(CREDIT_NOTE)).text, 'estado'), 'RECIBIDA');
  });

  test('consola: config en caliente, falla simulada (SOAP Fault 503) y listado', async () => {
    const cfg = await fetch(`${base}/admin/config`, { method: 'POST', body: JSON.stringify({ failRate: 1 }) }).then((r) => r.json());
    assert.equal(cfg.failRate, 1);
    const r = await send(SIGNED);
    assert.equal(r.status, 503);
    assert.ok(r.text.includes('<soap:Fault>'));
    await fetch(`${base}/admin/config`, { method: 'POST', body: JSON.stringify({ failRate: 0 }) });
    await send(SIGNED);
    const list = await fetch(`${base}/admin/comprobantes`).then((x) => x.json());
    assert.deepEqual(list.map((c) => [c.claveAcceso, c.estado]), [[KEY, 'RECIBIDA']]);
    const bad = await fetch(`${base}/admin/config`, { method: 'POST', body: JSON.stringify({ nada: 1 }) });
    assert.equal(bad.status, 400);
  });
});
