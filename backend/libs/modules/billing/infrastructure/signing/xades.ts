import { createHash, KeyObject, randomInt, sign, X509Certificate } from 'node:crypto';
import { ecuadorDateTime } from '../../domain/dates';
import { el, escapeText } from '../../domain/xml';

/**
 * Firma XAdES-BES "enveloped" del comprobante, como la exige el SRI (ficha técnica, anexo de
 * firma electrónica): RSA-SHA1, digests SHA-1 y tres referencias firmadas:
 *   1. SignedProperties (hora de firma y huella del certificado),
 *   2. KeyInfo (el certificado y la clave pública),
 *   3. el comprobante (#comprobante) con la transformación enveloped-signature.
 *
 * Canonicalización C14N 1.0 inclusiva sin librería: el XML del comprobante ya se escribe en
 * forma canónica (domain/xml.ts), y al canonicalizar un elemento de la firma por separado,
 * C14N agrega en él los espacios de nombres heredados de ds:Signature (xmlns:ds y xmlns:etsi),
 * que es exactamente lo que hace `NS` aquí.
 */
export const DS = 'http://www.w3.org/2000/09/xmldsig#';
export const ETSI = 'http://uri.etsi.org/01903/v1.3.2#';
const NS = ` xmlns:ds="${DS}" xmlns:etsi="${ETSI}"`;
const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const RSA_SHA1 = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';
const SHA1 = 'http://www.w3.org/2000/09/xmldsig#sha1';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';

export interface SigningMaterial {
  key: KeyObject;
  cert: X509Certificate;
}

export interface SignOptions {
  now?: Date;
  /** Sufijo de los Id de la firma (aleatorio si no se indica; fijo en los tests). */
  idSuffix?: string;
}

function sha1(data: string | Buffer): string {
  // La ficha técnica del SRI exige XAdES-BES con RSA-SHA1 y digest SHA-1: no es elección nuestra.
  // nosemgrep: moda-hash-debil
  return createHash('sha1').update(data).digest('base64');
}

const b64 = (base64url: string) => Buffer.from(base64url, 'base64url').toString('base64');

/** Nombre del emisor del certificado en RFC 2253 (orden inverso, separado por comas). */
export function rfc2253(name: string): string {
  return name
    .split('\n')
    .filter(Boolean)
    .reverse()
    .map((rdn) => {
      const i = rdn.indexOf('=');
      const value = rdn.slice(i + 1).replace(/([,+"\\<>;])/g, '\\$1');
      return `${rdn.slice(0, i)}=${value}`;
    })
    .join(',');
}

/** Referencia firmada: el digest se calcula sobre la forma canónica de la parte. */
function reference(attrs: Record<string, string>, digest: string, transforms = ''): string {
  return el('ds:Reference', [transforms, el('ds:DigestMethod', '', { Algorithm: SHA1 }), el('ds:DigestValue', digest)], attrs);
}

/**
 * Firma el comprobante (el elemento raíz, sin declaración XML y en forma canónica) y devuelve
 * el documento con ds:Signature como último hijo del elemento raíz.
 */
export function signXades(xml: string, { key, cert }: SigningMaterial, opts: SignOptions = {}): string {
  const root = /^<([A-Za-z_][\w.-]*)[\s>]/.exec(xml)?.[1];
  if (!root || !xml.endsWith(`</${root}>`)) throw new Error('El comprobante a firmar debe ser un único elemento raíz');
  if (!/^<[^>]* id="comprobante"/.test(xml)) throw new Error('El elemento raíz debe tener id="comprobante"');

  const n = opts.idSuffix ?? String(randomInt(100_000, 999_999));
  const ids = {
    signature: `Signature${n}`,
    signedInfo: `Signature-SignedInfo${n}`,
    signedPropsRef: `SignedPropertiesID${n}`,
    signedProps: `Signature${n}-SignedProperties${n}`,
    certificate: `Certificate${n}`,
    comprobanteRef: `Reference-ID-${n}`,
    signatureValue: `SignatureValue${n}`,
    object: `Signature${n}-Object${n}`,
  };

  const certDer = cert.raw;
  const jwk = cert.publicKey.export({ format: 'jwk' });
  if (!jwk.n || !jwk.e) throw new Error('El certificado de firma debe tener una clave RSA');

  // 1. SignedProperties (XAdES-BES): hora de firma, certificado firmante y formato del objeto.
  const signedPropsContent = [
    el('etsi:SignedSignatureProperties', [
      el('etsi:SigningTime', ecuadorDateTime(opts.now ?? new Date())),
      el(
        'etsi:SigningCertificate',
        el(
          'etsi:Cert',
          [
            el('etsi:CertDigest', [el('ds:DigestMethod', '', { Algorithm: SHA1 }), el('ds:DigestValue', sha1(certDer))]),
            el('etsi:IssuerSerial', [
              el('ds:X509IssuerName', escapeText(rfc2253(cert.issuer))),
              el('ds:X509SerialNumber', BigInt(`0x${cert.serialNumber}`).toString()),
            ]),
          ],
        ),
      ),
    ]),
    el(
      'etsi:SignedDataObjectProperties',
      el('etsi:DataObjectFormat', [el('etsi:Description', 'contenido comprobante'), el('etsi:MimeType', 'text/xml')], {
        ObjectReference: `#${ids.comprobanteRef}`,
      }),
    ),
  ];
  const signedProps = (ns: string) => el('etsi:SignedProperties', signedPropsContent, { Id: ids.signedProps }, ns);

  // 2. KeyInfo: certificado X.509 y módulo/exponente de la clave pública.
  const keyInfoContent = [
    el('ds:X509Data', el('ds:X509Certificate', certDer.toString('base64'))),
    el('ds:KeyValue', el('ds:RSAKeyValue', [el('ds:Modulus', b64(jwk.n)), el('ds:Exponent', b64(jwk.e))])),
  ];
  const keyInfo = (ns: string) => el('ds:KeyInfo', keyInfoContent, { Id: ids.certificate }, ns);

  // 3. SignedInfo con las tres referencias.
  const signedInfoContent = [
    el('ds:CanonicalizationMethod', '', { Algorithm: C14N }),
    el('ds:SignatureMethod', '', { Algorithm: RSA_SHA1 }),
    reference(
      { Id: ids.signedPropsRef, Type: 'http://uri.etsi.org/01903#SignedProperties', URI: `#${ids.signedProps}` },
      sha1(signedProps(NS)),
    ),
    reference({ URI: `#${ids.certificate}` }, sha1(keyInfo(NS))),
    reference(
      { Id: ids.comprobanteRef, URI: '#comprobante' },
      sha1(xml),
      el('ds:Transforms', el('ds:Transform', '', { Algorithm: ENVELOPED })),
    ),
  ];
  const signedInfo = (ns: string) => el('ds:SignedInfo', signedInfoContent, { Id: ids.signedInfo }, ns);
  const signatureValue = sign('sha1', Buffer.from(signedInfo(NS), 'utf8'), key).toString('base64');

  const signature = el(
    'ds:Signature',
    [
      signedInfo(''),
      el('ds:SignatureValue', signatureValue, { Id: ids.signatureValue }),
      keyInfo(''),
      el('ds:Object', el('etsi:QualifyingProperties', signedProps(''), { Target: `#${ids.signature}` }), { Id: ids.object }),
    ],
    { Id: ids.signature },
    NS,
  );
  return `${xml.slice(0, -`</${root}>`.length)}${signature}</${root}>`;
}
