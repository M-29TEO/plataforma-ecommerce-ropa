import { InvalidBuyerIdError } from './errors';

/**
 * Tipos de identificación del comprador (ficha técnica, tabla 6).
 * 07 consumidor final lleva siempre la identificación 9999999999999.
 */
export const BUYER_ID_TYPES = {
  RUC: '04',
  CEDULA: '05',
  PASAPORTE: '06',
  CONSUMIDOR_FINAL: '07',
  EXTERIOR: '08',
} as const;
export type BuyerIdType = (typeof BUYER_ID_TYPES)[keyof typeof BUYER_ID_TYPES];

export const CONSUMIDOR_FINAL_ID = '9999999999999';
export const CONSUMIDOR_FINAL_NAME = 'CONSUMIDOR FINAL';

/** Provincias 01-24 y 30 (ecuatorianos registrados en el exterior). */
function validProvince(digits: string): boolean {
  const p = Number(digits.slice(0, 2));
  return (p >= 1 && p <= 24) || p === 30;
}

/**
 * Cédula ecuatoriana: 10 dígitos, provincia válida, tercer dígito menor que 6 y dígito
 * verificador módulo 10 (coeficientes 2,1,2,1... sobre los 9 primeros; si un producto pasa de
 * 9 se le resta 9).
 */
export function isValidCedula(value: string): boolean {
  if (!/^\d{10}$/.test(value) || !validProvince(value) || Number(value[2]) >= 6) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let product = Number(value[i]) * (i % 2 === 0 ? 2 : 1);
    if (product > 9) product -= 9;
    sum += product;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === Number(value[9]);
}

/**
 * RUC: 13 dígitos que terminan en el número de establecimiento (001 en adelante). Para personas
 * naturales (tercer dígito 0-5) los 10 primeros son una cédula válida. Para sociedades (6 y 9)
 * solo se valida la provincia: el SRI emite desde hace años RUC de sociedades que ya no cumplen
 * el antiguo módulo 11, así que exigirlo rechazaría contribuyentes reales.
 */
export function isValidRuc(value: string): boolean {
  if (!/^\d{13}$/.test(value) || value.slice(10) === '000' || !validProvince(value)) return false;
  const third = Number(value[2]);
  if (third < 6) return isValidCedula(value.slice(0, 10));
  return third === 6 || third === 9;
}

/** Lanza InvalidBuyerIdError si la identificación no corresponde a su tipo. */
export function assertValidBuyerId(idType: string, idNumber: string): void {
  const fail = (reason: string) => {
    throw new InvalidBuyerIdError(idType, idNumber, reason);
  };
  switch (idType) {
    case BUYER_ID_TYPES.CEDULA:
      if (!isValidCedula(idNumber)) fail('la cédula no es válida');
      return;
    case BUYER_ID_TYPES.RUC:
      if (!isValidRuc(idNumber)) fail('el RUC no es válido');
      return;
    case BUYER_ID_TYPES.PASAPORTE:
    case BUYER_ID_TYPES.EXTERIOR:
      if (!/^[A-Za-z0-9]{3,20}$/.test(idNumber)) fail('debe tener de 3 a 20 letras o números');
      return;
    case BUYER_ID_TYPES.CONSUMIDOR_FINAL:
      if (idNumber !== CONSUMIDOR_FINAL_ID) fail(`consumidor final se identifica con ${CONSUMIDOR_FINAL_ID}`);
      return;
    default:
      fail('tipo de identificación desconocido');
  }
}
