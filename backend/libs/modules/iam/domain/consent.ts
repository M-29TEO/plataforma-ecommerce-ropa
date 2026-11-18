import { ValidationError } from '../../../shared-kernel';

/** Propósitos del CHECK de iam.consents (LOPDP). */
export const CONSENT_PURPOSES = [
  'terms',
  'privacy',
  'marketing_email',
  'marketing_whatsapp',
  'marketing_sms',
  'profiling',
  'cookies_analytics',
] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

/** Una fila de iam.consents: el historial es de solo inserción, nunca se actualiza. */
export interface ConsentRecord {
  purpose: ConsentPurpose;
  granted: boolean;
  policyVersion: string;
  createdAt: Date;
}

export interface ConsentState {
  purpose: ConsentPurpose;
  granted: boolean;
  policyVersion: string | null;
  updatedAt: Date | null;
}

/**
 * Estado vigente por propósito: manda la fila más reciente. Sin filas, el consentimiento NO está
 * otorgado (opt-in: la LOPDP exige consentimiento expreso; el silencio no cuenta).
 */
export function currentConsents(records: readonly ConsentRecord[]): ConsentState[] {
  const latest = new Map<ConsentPurpose, ConsentRecord>();
  for (const r of records) {
    const prev = latest.get(r.purpose);
    if (!prev || r.createdAt.getTime() >= prev.createdAt.getTime()) latest.set(r.purpose, r);
  }
  return CONSENT_PURPOSES.map((purpose) => {
    const r = latest.get(purpose);
    return r
      ? { purpose, granted: r.granted, policyVersion: r.policyVersion, updatedAt: r.createdAt }
      : { purpose, granted: false, policyVersion: null, updatedAt: null };
  });
}

/** Sin estos dos no hay cuenta: aceptar los términos y la política de privacidad (LOPDP art. 8). */
export const REQUIRED_CONSENTS = ['terms', 'privacy'] as const satisfies readonly ConsentPurpose[];

/** Lo que el cliente marca en el formulario de registro. El marketing es opcional y opt-in. */
export interface RegistrationConsents {
  terms: boolean;
  privacy: boolean;
  marketingEmail?: boolean;
  marketingWhatsapp?: boolean;
  marketingSms?: boolean;
}

/**
 * Filas de iam.consents del registro: términos y privacidad (obligatorios: si falta alguno,
 * CONSENT_REQUIRED) y los propósitos de marketing que el cliente decidió, sí o no. Lo que no
 * contestó no se registra: sin fila, el propósito cuenta como NO otorgado.
 */
export function registrationConsentChanges(c: RegistrationConsents): { purpose: ConsentPurpose; granted: boolean }[] {
  const missing = REQUIRED_CONSENTS.filter((p) => c[p] !== true);
  if (missing.length > 0) {
    throw new ValidationError('CONSENT_REQUIRED', 'Debes aceptar los términos y la política de privacidad', { missing });
  }
  const changes: { purpose: ConsentPurpose; granted: boolean }[] = [
    { purpose: 'terms', granted: true },
    { purpose: 'privacy', granted: true },
  ];
  const optional: [keyof RegistrationConsents, ConsentPurpose][] = [
    ['marketingEmail', 'marketing_email'],
    ['marketingWhatsapp', 'marketing_whatsapp'],
    ['marketingSms', 'marketing_sms'],
  ];
  for (const [field, purpose] of optional) {
    if (typeof c[field] === 'boolean') changes.push({ purpose, granted: c[field] as boolean });
  }
  return changes;
}

/**
 * Términos y privacidad no se revocan desde "Mi cuenta": sin ellos no se puede prestar el
 * servicio. Retirarlos es pedir la supresión de la cuenta (derecho de eliminación), otro flujo.
 */
export function assertRevocable(changes: readonly { purpose: ConsentPurpose; granted: boolean }[]): void {
  const blocked = changes.filter((c) => !c.granted && (REQUIRED_CONSENTS as readonly string[]).includes(c.purpose)).map((c) => c.purpose);
  if (blocked.length > 0) {
    throw new ValidationError(
      'CONSENT_NOT_REVOCABLE',
      'Los términos y la política de privacidad no se pueden revocar; para retirarlos solicita la eliminación de tu cuenta',
      { purposes: blocked },
    );
  }
}
