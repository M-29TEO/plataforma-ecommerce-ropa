import { assertRevocable, currentConsents, registrationConsentChanges } from './consent';

describe('currentConsents', () => {
  const at = (iso: string) => new Date(iso);

  it('sin filas, ningún propósito está otorgado (opt-in)', () => {
    const states = currentConsents([]);
    expect(states.every((s) => s.granted === false && s.updatedAt === null)).toBe(true);
    expect(states.map((s) => s.purpose)).toContain('marketing_email');
  });

  it('manda la fila más reciente de cada propósito, sin importar el orden', () => {
    const states = currentConsents([
      { purpose: 'marketing_email', granted: false, policyVersion: 'v2', createdAt: at('2026-09-02T00:00:00Z') },
      { purpose: 'marketing_email', granted: true, policyVersion: 'v1', createdAt: at('2026-09-01T00:00:00Z') },
      { purpose: 'marketing_sms', granted: true, policyVersion: 'v1', createdAt: at('2026-09-01T00:00:00Z') },
    ]);
    const byPurpose = Object.fromEntries(states.map((s) => [s.purpose, s]));
    expect(byPurpose.marketing_email).toMatchObject({ granted: false, policyVersion: 'v2' });
    expect(byPurpose.marketing_sms).toMatchObject({ granted: true });
    expect(byPurpose.marketing_whatsapp.granted).toBe(false);
  });
});

describe('consentimientos del registro', () => {
  it('términos y privacidad son obligatorios', () => {
    expect(() => registrationConsentChanges({ terms: true, privacy: false })).toThrow(
      expect.objectContaining({ code: 'CONSENT_REQUIRED', details: { missing: ['privacy'] } }),
    );
    expect(() => registrationConsentChanges({ terms: false, privacy: false })).toThrow(
      expect.objectContaining({ details: { missing: ['terms', 'privacy'] } }),
    );
  });

  it('registra el marketing que el cliente contestó (sí o no) y omite lo que no contestó', () => {
    expect(registrationConsentChanges({ terms: true, privacy: true, marketingEmail: true, marketingSms: false })).toEqual([
      { purpose: 'terms', granted: true },
      { purpose: 'privacy', granted: true },
      { purpose: 'marketing_email', granted: true },
      { purpose: 'marketing_sms', granted: false },
    ]);
    expect(registrationConsentChanges({ terms: true, privacy: true })).toHaveLength(2);
  });

  it('términos y privacidad no se revocan desde Mi cuenta; el marketing sí', () => {
    expect(() => assertRevocable([{ purpose: 'privacy', granted: false }])).toThrow(
      expect.objectContaining({ code: 'CONSENT_NOT_REVOCABLE', details: { purposes: ['privacy'] } }),
    );
    expect(() => assertRevocable([{ purpose: 'terms', granted: true }, { purpose: 'marketing_email', granted: false }])).not.toThrow();
  });
});
