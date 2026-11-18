import { ApiError } from './api-client';
import { fromCents, isPositiveAmount, toCents } from './format';
import { isValidOtp } from './shipment-flow';
import type { CodMethod } from './types';

/** Datos del formulario de prueba de entrega antes de enviarlo. */
export interface DeliveryDraft {
  photoUri: string | null;
  signatureComplete: boolean;
  receiverName: string;
  otp: string;
  requiresOtp: boolean;
  codAmount: string;
  codMethod: CodMethod;
  codConfirmed: boolean;
}

export type DraftErrors = Partial<Record<'photo' | 'signature' | 'receiverName' | 'otp' | 'cod', string>>;

export function validateDraft(d: DeliveryDraft): DraftErrors {
  const errors: DraftErrors = {};
  if (!d.photoUri) errors.photo = 'Toma una foto del paquete entregado';
  if (!d.signatureComplete) errors.signature = 'Falta la firma de quien recibe';
  const name = d.receiverName.trim();
  if (name.length < 2 || name.length > 120) errors.receiverName = 'Escribe el nombre de quien recibe';
  if (d.requiresOtp && !isValidOtp(d.otp.trim())) errors.otp = 'El código tiene 4 dígitos';
  if (isPositiveAmount(d.codAmount) && !d.codConfirmed) errors.cod = 'Confirma que cobraste el monto';
  return errors;
}

/** Vuelto del pago en efectivo; null si lo recibido no alcanza o no es un monto. */
export function changeDue(codAmount: string, received: string): string | null {
  try {
    const diff = toCents(received) - toCents(codAmount);
    return diff >= 0 ? fromCents(diff) : null;
  } catch {
    return null;
  }
}

/** Mensaje claro para cada rechazo de la API al entregar. */
export function deliveryErrorMessage(e: ApiError): string {
  switch (e.code) {
    case 'OTP_INVALID': {
      const left = typeof e.details.attemptsLeft === 'number' ? e.details.attemptsLeft : null;
      return `Código incorrecto.${left !== null ? ` Te quedan ${left} intentos.` : ''} Pídele al cliente que lo revise en su seguimiento.`;
    }
    case 'OTP_REQUIRED':
      return 'Falta el código de entrega: pídeselo al cliente.';
    case 'PROOF_PHOTO_TYPE':
    case 'PROOF_PHOTO_TOO_LARGE':
      return 'La foto no es válida o es muy pesada: toma otra.';
    case 'PROOF_SIGNATURE_TYPE':
    case 'PROOF_SIGNATURE_TOO_LARGE':
      return 'La firma no se pudo procesar: bórrala y vuelve a firmar.';
    case 'RIDER_COD_LIMIT':
      return 'Llegaste a tu tope de efectivo: entrega lo cobrado en bodega.';
    case 'OTP_LOCKED':
      return 'Demasiados códigos incorrectos: espera 15 minutos o llama a logística.';
    case 'DELIVERY_TOO_FAR':
      return e.message;
    case 'COD_AMOUNT_MISMATCH':
      return 'El monto cobrado no coincide con el del pedido.';
    case 'PROOF_PHOTO_REQUIRED':
      return 'Falta la foto de la entrega.';
    case 'PROOF_SIGNATURE_REQUIRED':
      return 'Falta la firma.';
    default:
      return e.message;
  }
}
