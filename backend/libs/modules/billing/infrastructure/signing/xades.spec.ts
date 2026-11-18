import { createHash, verify } from 'node:crypto';
import { resolve } from 'node:path';
import { invoiceData } from '../../domain/invoice.fixture';
import { buildInvoiceXml } from '../../domain/invoice-xml';
import { loadSigningMaterial } from './pem-invoice-signer';
import { DS, ETSI, rfc2253, signXades } from './xades';

const FIXTURES = resolve(__dirname, '../../../../../test/fixtures/sri');
const material = loadSigningMaterial(`${FIXTURES}/firma.crt.pem`, `${FIXTURES}/firma.key.pem`);
const NS = ` xmlns:ds="${DS}" xmlns:etsi="${ETSI}"`;
const sha1 = (s: string | Buffer) => createHash('sha1').update(s).digest('base64');

/** Elemento completo (con sus hijos) por nombre, tal como está en el documento. */
function element(xml: string, name: string): string {
  const start = xml.indexOf(`<${name}`);
  const endTag = `</${name}>`;
  const end = xml.indexOf(endTag, start);
  if (start < 0 || end < 0) throw new Error(`No está ${name}`);
  return xml.slice(start, end + endTag.length);
}

/** C14N de un elemento de la firma canonicalizado por separado: hereda xmlns:ds y xmlns:etsi. */
const withNs = (el: string) => el.replace(/^<([\w:]+)/, `<$1${NS}`);

function digestOf(xml: string, uri: string): string {
  const ref = [...xml.matchAll(/<ds:Reference [^>]*URI="([^"]+)"[^>]*>(.*?)<\/ds:Reference>/g)].find((m) => m[1] === uri);
  return /<ds:DigestValue>([^<]+)<\/ds:DigestValue>/.exec(ref![2])![1];
}

describe('firma XAdES-BES', () => {
  const unsigned = buildInvoiceXml(invoiceData());
  const now = new Date('2026-09-30T15:20:00Z');
  const signed = signXades(unsigned, material, { now, idSuffix: '123456' });

  test('ds:Signature es el último hijo de factura y quitarla devuelve el comprobante original', () => {
    expect(signed.endsWith('</ds:Signature></factura>')).toBe(true);
    const signature = element(signed, 'ds:Signature');
    expect(signed.replace(signature, '')).toBe(unsigned);
    expect(signature.startsWith(`<ds:Signature${NS} Id="Signature123456">`)).toBe(true);
  });

  test('las tres referencias tienen el digest SHA-1 de su parte canonicalizada', () => {
    expect(digestOf(signed, '#comprobante')).toBe(sha1(unsigned));
    expect(digestOf(signed, '#Signature123456-SignedProperties123456')).toBe(sha1(withNs(element(signed, 'etsi:SignedProperties'))));
    expect(digestOf(signed, '#Certificate123456')).toBe(sha1(withNs(element(signed, 'ds:KeyInfo'))));
  });

  test('SignatureValue verifica con la clave pública del certificado (RSA-SHA1 sobre SignedInfo canónico)', () => {
    const signedInfo = withNs(element(signed, 'ds:SignedInfo'));
    const value = /<ds:SignatureValue [^>]*>([^<]+)</.exec(signed)![1];
    expect(verify('sha1', Buffer.from(signedInfo), material.cert.publicKey, Buffer.from(value, 'base64'))).toBe(true);

    const tampered = signedInfo.replace(sha1(unsigned), sha1(`${unsigned} `));
    expect(verify('sha1', Buffer.from(tampered), material.cert.publicKey, Buffer.from(value, 'base64'))).toBe(false);
  });

  test('SignedProperties: hora de Ecuador, huella y emisor/serie del certificado', () => {
    expect(signed).toContain('<etsi:SigningTime>2026-09-30T10:20:00-05:00</etsi:SigningTime>');
    expect(signed).toContain(`<ds:DigestValue>${sha1(material.cert.raw)}</ds:DigestValue>`);
    expect(signed).toContain(`<ds:X509SerialNumber>${BigInt(`0x${material.cert.serialNumber}`)}</ds:X509SerialNumber>`);
    expect(signed).toContain('<ds:X509IssuerName>CN=MODA DEMO S.A.,serialNumber=1790000000001,');
    expect(signed).toContain(`<ds:X509Certificate>${material.cert.raw.toString('base64')}</ds:X509Certificate>`);
  });

  test('rfc2253 invierte el orden y escapa comas', () => {
    expect(rfc2253('C=EC\nO=Moda, Demo\nCN=Firma')).toBe('CN=Firma,O=Moda\\, Demo,C=EC');
  });

  test('exige un comprobante con id="comprobante"', () => {
    expect(() => signXades('<factura version="2.1.0"></factura>', material)).toThrow(/comprobante/);
  });
});
