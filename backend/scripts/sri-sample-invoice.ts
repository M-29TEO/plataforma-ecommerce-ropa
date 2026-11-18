/**
 * Imprime un comprobante de ejemplo firmado con XAdES-BES por el código del backend (datos de
 * libs/modules/billing/domain/invoice.fixture.ts). Genera los fixtures del SRI simulado, que así
 * verifica una firma hecha por el backend con su propio C14N:
 *
 *   npm run -s sri:sample > ../simulators/sri/fixtures/factura-firmada.xml
 *   npm run -s sri:sample -- --totales-mal > ../simulators/sri/fixtures/factura-totales-mal.xml
 *   npm run -s sri:sample -- --nota-credito > ../simulators/sri/fixtures/nota-credito-firmada.xml
 *
 * La nota de crédito modifica la factura 001-001-000000001 de factura-firmada.xml (devuelve una de
 * sus dos blusas). Firma con SRI_CERT_PATH / SRI_KEY_PATH (por defecto, el certificado de test/fixtures/sri).
 */
import { buildCreditNoteXml } from '../libs/modules/billing/domain/credit-note-xml';
import { buildInvoiceXml, XML_DECLARATION } from '../libs/modules/billing/domain/invoice-xml';
import { creditNoteData, invoiceData } from '../libs/modules/billing/domain/invoice.fixture';
import { loadSigningMaterial } from '../libs/modules/billing/infrastructure/signing/pem-invoice-signer';
import { signXades } from '../libs/modules/billing/infrastructure/signing/xades';

const badTotals = process.argv.includes('--totales-mal');
const creditNote = process.argv.includes('--nota-credito');
const material = loadSigningMaterial(
  process.env.SRI_CERT_PATH || 'test/fixtures/sri/firma.crt.pem',
  process.env.SRI_KEY_PATH || 'test/fixtures/sri/firma.key.pem',
);
let xml = creditNote ? buildCreditNoteXml(creditNoteData()) : buildInvoiceXml(invoiceData({}, badTotals ? 2 : 1));
// Firmado correctamente, pero con el importe total alterado ANTES de firmar: la firma verifica y
// el SRI debe rechazarlo por "ERROR EN DIFERENCIAS".
if (badTotals) xml = xml.replace('<importeTotal>76.70</importeTotal>', '<importeTotal>80.00</importeTotal>');
process.stdout.write(XML_DECLARATION + signXades(xml, material, { now: new Date('2026-09-30T15:20:00Z') }) + '\n');
