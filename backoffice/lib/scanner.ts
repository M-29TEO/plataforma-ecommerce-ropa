/**
 * Lógica pura del escaneo de códigos de barras (sin DOM): normalización, dígito verificador
 * EAN/UPC, antirrebote y diagnóstico del soporte de cámara. La usa components/scanner/.
 */

/** Formatos que pide el lector (nombres del BarcodeDetector nativo). */
export const BARCODE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'] as const;

/** Mismo código leído dos veces dentro de esta ventana = una sola lectura (la cámara lee en bucle). */
export const DEBOUNCE_MS = 1500;

/** Largo máximo que acepta el API (?barcode= admite 1..64). */
export const MAX_CODE_LENGTH = 64;

/**
 * Limpia lo que entrega un lector: espacios alrededor, caracteres de control (los lectores USB a
 * veces mandan \r, \t, GS de GS1 o prefijos de control) y espacios internos repetidos.
 */
export function normalizeBarcode(raw: string): string {
  return raw.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim().replace(/\s+/g, ' ').slice(0, MAX_CODE_LENGTH);
}

/** Dígito verificador GS1 (EAN-8, EAN-13, UPC-A, GTIN-14) de los dígitos SIN el verificador. */
export function gs1CheckDigit(body: string): number {
  let sum = 0;
  // Desde la derecha: pesos 3, 1, 3, 1...
  for (let i = body.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(body[i]) * w;
  return (10 - (sum % 10)) % 10;
}

function validGs1(code: string): boolean {
  return gs1CheckDigit(code.slice(0, -1)) === Number(code[code.length - 1]);
}

/** UPC-E (8 dígitos, sistema 0 o 1) → UPC-A de 12 dígitos, o null si no es expandible. */
export function expandUpcE(code: string): string | null {
  if (!/^[01]\d{7}$/.test(code)) return null;
  const ns = code[0];
  const d = code.slice(1, 7);
  const check = code[7];
  const last = d[5];
  let body: string;
  if (last <= '2') body = `${d[0]}${d[1]}${last}0000${d[2]}${d[3]}${d[4]}`;
  else if (last === '3') body = `${d[0]}${d[1]}${d[2]}00000${d[3]}${d[4]}`;
  else if (last === '4') body = `${d[0]}${d[1]}${d[2]}${d[3]}00000${d[4]}`;
  else body = `${d[0]}${d[1]}${d[2]}${d[3]}${d[4]}0000${last}`;
  return `${ns}${body}${check}`;
}

export type BarcodeKind = 'ean13' | 'ean8' | 'upca' | 'upce' | 'gtin14' | 'other';

/**
 * Tipo probable del código y si su dígito verificador cuadra. Los códigos no numéricos (Code 128,
 * Code 39, QR con el SKU) no tienen verificador GS1: se dan por válidos (kind 'other').
 */
export function checkBarcode(code: string): { kind: BarcodeKind; valid: boolean } {
  if (!/^\d+$/.test(code)) return { kind: 'other', valid: code.length > 0 };
  switch (code.length) {
    case 13:
      return { kind: 'ean13', valid: validGs1(code) };
    case 12:
      return { kind: 'upca', valid: validGs1(code) };
    case 14:
      return { kind: 'gtin14', valid: validGs1(code) };
    case 8: {
      if (validGs1(code)) return { kind: 'ean8', valid: true };
      const upca = expandUpcE(code);
      if (upca && validGs1(upca)) return { kind: 'upce', valid: true };
      return { kind: 'ean8', valid: false };
    }
    default:
      // Numérico de otro largo: Code 128 / Code 39 con un código interno.
      return { kind: 'other', valid: true };
  }
}

/**
 * Antirrebote: devuelve una función que responde true si la lectura se acepta. Ignora el MISMO
 * código repetido antes de `windowMs` desde su última lectura aceptada; un código distinto pasa
 * siempre. `now` inyectable para probarlo.
 */
export function createDebouncer(windowMs = DEBOUNCE_MS, now: () => number = Date.now): (code: string) => boolean {
  let lastCode: string | null = null;
  let lastAt = -Infinity;
  return (code: string) => {
    const t = now();
    if (code === lastCode && t - lastAt < windowMs) return false;
    lastCode = code;
    lastAt = t;
    return true;
  };
}

export type CameraSupport = 'ok' | 'insecure' | 'unsupported';

/** La cámara (getUserMedia) solo existe en contexto seguro: HTTPS o localhost. */
export function cameraSupport(env: { isSecureContext: boolean; hasGetUserMedia: boolean }): CameraSupport {
  if (!env.isSecureContext) return 'insecure';
  if (!env.hasGetUserMedia) return 'unsupported';
  return 'ok';
}

/** Mensaje claro para cada error de getUserMedia (DOMException.name). */
export function cameraErrorMessage(name: string | undefined): string {
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'Permiso de cámara denegado. Habilítalo en la configuración del navegador (ícono del candado) y vuelve a intentarlo, o escribe el código.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'No se encontró una cámara en este equipo. Usa un lector de códigos o escribe el código.';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'La cámara está ocupada por otra aplicación o pestaña. Ciérrala y reintenta.';
    default:
      return 'No se pudo abrir la cámara. Escribe el código o usa un lector.';
  }
}

export const INSECURE_CONTEXT_MESSAGE =
  'La cámara solo funciona con HTTPS o en localhost. Abre el backoffice con https:// (o usa un lector USB/Bluetooth o la entrada manual).';

/** GET /catalog/variants/lookup → 0 o 1 resultado con ?barcode=, hasta 20 con ?q=. */
export interface VariantLookupItem {
  variantId: string;
  productId: string;
  sku: string;
  barcode: string | null;
  productName: string;
  color: string | null;
  size: string | null;
  /** Precio efectivo sin IVA (numeric como string). */
  price: string;
  status: string;
  productStatus?: string;
}

/** "Camisa Oxford · Azul · M" */
export function variantLabel(v: Pick<VariantLookupItem, 'productName' | 'color' | 'size'>): string {
  return [v.productName, v.color, v.size].filter(Boolean).join(' · ');
}

/** Tope de ?ids= del lookup por llamada. */
export const LOOKUP_IDS_BATCH = 100;

/**
 * Ids aún sin nombre agrupados en lotes para GET /catalog/variants/lookup?ids=. Sin repetidos y
 * ordenados: así los lotes (y sus claves de caché) no cambian mientras se resuelven otros.
 */
export function missingIdBatches(ids: readonly string[], isKnown: (id: string) => boolean, size = LOOKUP_IDS_BATCH): string[][] {
  const missing = [...new Set(ids)].filter((id) => id && !isKnown(id)).sort();
  const out: string[][] = [];
  for (let i = 0; i < missing.length; i += size) out.push(missing.slice(i, i + size));
  return out;
}
