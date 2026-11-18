import { ValidationError } from './errors/domain-error';

/**
 * Tarifas de IVA por "código de porcentaje" del SRI (ficha técnica de comprobantes
 * electrónicos, tabla 17). catalog.products.tax_code guarda este código; '4' = 15 % es la
 * tarifa general vigente. Las tasas van en puntos básicos (15 % = 1500) para operar con
 * enteros, igual que el dinero en centavos.
 *
 * El código 8 (IVA diferenciado por feriados) no se admite: su tasa depende del decreto
 * de turno y no aplica a una tienda en línea.
 */
export const IVA_RATES_BP: Readonly<Record<string, number>> = {
  '0': 0, // 0 %
  '2': 1200, // 12 % (histórico)
  '3': 1400, // 14 % (histórico)
  '4': 1500, // 15 %
  '5': 500, // 5 %
  '6': 0, // no objeto de impuesto
  '7': 0, // exento de IVA
  '10': 1300, // 13 %
};

export class UnknownTaxCodeError extends ValidationError {
  constructor(taxCode: string) {
    super('UNKNOWN_TAX_CODE', `Código de IVA desconocido: "${taxCode}"`, { taxCode });
  }
}

/** Tasa en puntos básicos para un código de IVA del SRI. */
export function ivaRateBp(taxCode: string): number {
  const rate = IVA_RATES_BP[taxCode];
  if (rate === undefined) throw new UnknownTaxCodeError(taxCode);
  return rate;
}

/** IVA de una base en centavos, redondeado al centavo (mitad hacia arriba), como la factura. */
export function ivaCents(baseCents: number, rateBp: number): number {
  return Math.round((baseCents * rateBp) / 10_000);
}

/** 1500 → "15.00" (formato de numeric(5,2) en order_items.tax_rate). */
export function formatRate(rateBp: number): string {
  return `${Math.floor(rateBp / 100)}.${String(rateBp % 100).padStart(2, '0')}`;
}
