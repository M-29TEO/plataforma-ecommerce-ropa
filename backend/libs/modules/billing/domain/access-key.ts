import { InvalidAccessKeyError } from './errors';

/**
 * Clave de acceso de 49 dígitos (ficha técnica de comprobantes electrónicos del SRI, esquema
 * offline). Identifica el comprobante de forma única y va en el XML, el RIDE y las consultas:
 *
 *   fecha de emisión   ddmmaaaa   8
 *   tipo comprobante   01 factura 2
 *   RUC del emisor                13
 *   ambiente           1 pruebas / 2 producción   1
 *   serie              establecimiento + punto de emisión   6
 *   secuencial                    9
 *   código numérico    lo elige el emisor   8
 *   tipo de emisión    1 normal   1
 *   dígito verificador módulo 11 1
 */
export const ACCESS_KEY_LENGTH = 49;

export interface AccessKeyParts {
  /** AAAA-MM-DD (fecha de emisión en America/Guayaquil). */
  issueDate: string;
  docType: string;
  ruc: string;
  environment: 1 | 2;
  establishment: string;
  emissionPoint: string;
  sequential: number;
  numericCode: string;
  emissionType: '1';
}

/**
 * Dígito verificador módulo 11: se multiplica cada dígito, de derecha a izquierda, por los
 * factores 2, 3, 4, 5, 6, 7 (y se vuelve a 2); se suman los productos y el dígito es
 * 11 − (suma mod 11). Si da 11 el dígito es 0 y si da 10 es 1.
 */
export function mod11CheckDigit(digits: string): number {
  if (!/^\d+$/.test(digits)) throw new InvalidAccessKeyError('El módulo 11 solo se calcula sobre dígitos', { digits });
  let sum = 0;
  let factor = 2;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += Number(digits[i]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const result = 11 - (sum % 11);
  if (result === 11) return 0;
  if (result === 10) return 1;
  return result;
}

function exact(name: string, value: string, length: number): string {
  if (!new RegExp(`^\\d{${length}}$`).test(value)) {
    throw new InvalidAccessKeyError(`${name} debe tener ${length} dígitos`, { [name]: value });
  }
  return value;
}

export function buildAccessKey(p: AccessKeyParts): string {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p.issueDate);
  if (!date) throw new InvalidAccessKeyError('La fecha de emisión debe ser AAAA-MM-DD', { issueDate: p.issueDate });
  if (!Number.isInteger(p.sequential) || p.sequential < 1 || p.sequential > 999_999_999) {
    throw new InvalidAccessKeyError('El secuencial va de 1 a 999999999', { sequential: p.sequential });
  }
  if (p.environment !== 1 && p.environment !== 2) {
    throw new InvalidAccessKeyError('El ambiente es 1 (pruebas) o 2 (producción)', { environment: p.environment });
  }
  const first48 =
    `${date[3]}${date[2]}${date[1]}` +
    exact('docType', p.docType, 2) +
    exact('ruc', p.ruc, 13) +
    String(p.environment) +
    exact('establishment', p.establishment, 3) +
    exact('emissionPoint', p.emissionPoint, 3) +
    String(p.sequential).padStart(9, '0') +
    exact('numericCode', p.numericCode, 8) +
    exact('emissionType', p.emissionType, 1);
  return first48 + String(mod11CheckDigit(first48));
}

/** Formato y dígito verificador correctos. */
export function isValidAccessKey(key: string): boolean {
  return /^\d{49}$/.test(key) && mod11CheckDigit(key.slice(0, 48)) === Number(key[48]);
}

/** Descompone una clave válida (lanza si el formato o el dígito verificador no cuadran). */
export function parseAccessKey(key: string): AccessKeyParts {
  if (!isValidAccessKey(key)) throw new InvalidAccessKeyError('Clave de acceso inválida', { key });
  const environment = Number(key[23]);
  if (environment !== 1 && environment !== 2) throw new InvalidAccessKeyError('Ambiente inválido en la clave', { key });
  if (key[47] !== '1') throw new InvalidAccessKeyError('Tipo de emisión inválido en la clave', { key });
  return {
    issueDate: `${key.slice(4, 8)}-${key.slice(2, 4)}-${key.slice(0, 2)}`,
    docType: key.slice(8, 10),
    ruc: key.slice(10, 23),
    environment,
    establishment: key.slice(24, 27),
    emissionPoint: key.slice(27, 30),
    sequential: Number(key.slice(30, 39)),
    numericCode: key.slice(39, 47),
    emissionType: '1',
  };
}
