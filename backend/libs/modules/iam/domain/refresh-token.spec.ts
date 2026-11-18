import { decideRefresh, generateRefreshToken, hashRefreshToken } from './refresh-token';

describe('refresh tokens', () => {
  const now = new Date('2026-10-02T15:00:00Z');
  const later = new Date(now.getTime() + 60_000);

  it('genera 32 bytes aleatorios en base64url', () => {
    const a = generateRefreshToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateRefreshToken()).not.toBe(a);
  });

  it('el hash es SHA-256 (32 bytes) y determinista', () => {
    expect(hashRefreshToken('abc').toString('hex')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hashRefreshToken('abc').length).toBe(32);
  });

  it('vigente y sin revocar: rota', () => {
    expect(decideRefresh({ expiresAt: later, revokedAt: null }, now)).toBe('rotate');
  });

  it('ya revocado (rotado o cerrado): reutilización, aunque además haya vencido', () => {
    expect(decideRefresh({ expiresAt: later, revokedAt: now }, now)).toBe('reused');
    expect(decideRefresh({ expiresAt: new Date(0), revokedAt: now }, now)).toBe('reused');
  });

  it('vencido (incluido el instante exacto): expirado', () => {
    expect(decideRefresh({ expiresAt: now, revokedAt: null }, now)).toBe('expired');
    expect(decideRefresh({ expiresAt: new Date(now.getTime() - 1), revokedAt: null }, now)).toBe('expired');
  });
});
