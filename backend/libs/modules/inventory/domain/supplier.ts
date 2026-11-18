import { ValidationError } from '../../../shared-kernel';

export interface SupplierContact {
  name?: string;
  email?: string;
  phone?: string;
  address?: string;
}

export interface Supplier {
  id: string;
  tenantId: string;
  name: string;
  ruc: string | null;
  contact: SupplierContact;
  leadTimeDays: number | null;
  active: boolean;
}

/**
 * RUC ecuatoriano: 13 dígitos, provincia 01-24 (o 30 para extranjeros) y sufijo de
 * establecimiento distinto de 000. No se valida el dígito verificador porque varía según
 * el tipo de contribuyente (persona natural, sociedad privada, entidad pública).
 */
export function normalizeRuc(ruc: string): string {
  const value = ruc.trim();
  if (!/^\d{13}$/.test(value)) throw new ValidationError('INVALID_RUC', 'El RUC debe tener 13 dígitos');
  const province = Number(value.slice(0, 2));
  if (!((province >= 1 && province <= 24) || province === 30)) {
    throw new ValidationError('INVALID_RUC', 'Código de provincia del RUC inválido');
  }
  if (value.endsWith('000')) throw new ValidationError('INVALID_RUC', 'El establecimiento del RUC no puede ser 000');
  return value;
}
