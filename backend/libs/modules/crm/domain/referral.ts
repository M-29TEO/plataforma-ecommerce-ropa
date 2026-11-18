import { randomInt } from 'node:crypto';

export const REFERRAL_STATUSES = ['registered', 'qualified', 'rewarded', 'rejected'] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

export interface Referral {
  id: string;
  tenantId: string;
  referrerId: string;
  refereeId: string;
  status: ReferralStatus;
  qualifyingOrder: string | null;
  rewardedAt: Date | null;
  createdAt: Date;
}

/** Sin 0/O, 1/I/L ni U: se dictan por teléfono y se copian a mano sin confusiones. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export const REFERRAL_CODE_LENGTH = 8;

export function generateReferralCode(): string {
  let code = '';
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

/** "abcd-2345 " → "ABCD2345"; null si no puede ser un código. */
export function normalizeReferralCode(input: string): string | null {
  const code = String(input ?? '')
    .toUpperCase()
    .replace(/[\s-]/g, '');
  if (code.length !== REFERRAL_CODE_LENGTH) return null;
  for (const ch of code) if (!ALPHABET.includes(ch)) return null;
  return code;
}

/**
 * Ciclo del referido:
 *  registered → qualified  primer pedido entregado del referido con al menos el monto mínimo;
 *  qualified  → rewarded   ese pedido pasó el plazo de devolución sin devolverse completo (cupón al referente);
 *  qualified  → rejected   el pedido se devolvió completo;
 *  registered → rejected   (manual, fraude).
 */
const TRANSITIONS: Record<ReferralStatus, readonly ReferralStatus[]> = {
  registered: ['qualified', 'rejected'],
  qualified: ['rewarded', 'rejected'],
  rewarded: [],
  rejected: [],
};

export function canTransitionReferral(from: ReferralStatus, to: ReferralStatus): boolean {
  return TRANSITIONS[from].includes(to);
}
