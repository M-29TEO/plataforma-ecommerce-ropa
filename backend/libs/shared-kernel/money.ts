import { ValidationError } from './errors/domain-error';

/**
 * Dinero en USD con 2 decimales (numeric(12,2) en PostgreSQL).
 * Se opera en centavos enteros para no acumular errores de coma flotante;
 * hacia y desde la base de datos viaja como string ("12.50").
 */
const MONEY_RE = /^\d{1,10}(\.\d{1,2})?$/;

export function toCents(value: string | number): number {
  const text = typeof value === 'number' ? value.toString() : value.trim();
  if (!MONEY_RE.test(text)) {
    throw new ValidationError('INVALID_MONEY', `Monto inválido: "${value}" (máximo 2 decimales, no negativo)`);
  }
  const [units, decimals = ''] = text.split('.');
  return Number(units) * 100 + Number(decimals.padEnd(2, '0'));
}

export function fromCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
