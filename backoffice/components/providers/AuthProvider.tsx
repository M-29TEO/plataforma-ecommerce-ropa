'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { type AccessToken, api, getAccessToken, hasSessionHint, onAccessTokenChange, refreshSession, setAccessToken } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { decodeClaims } from '@/lib/token';
import type { MfaChallenge, MfaEnrollment, UserProfile } from '@/lib/types';

type Status = 'loading' | 'guest' | 'authenticated';

/** Resultado del paso de contraseña: sesión abierta o falta el segundo factor. */
export type LoginStep = { kind: 'done' } | { kind: 'mfa'; mfaToken: string } | { kind: 'mfa-setup'; mfaToken: string };

interface AuthContextValue {
  status: Status;
  user: UserProfile | null;
  /** Permisos del JWT vigente (se actualizan en cada refresh: un cambio de rol rige en ≤ 15 min). */
  permissions: string[];
  login(email: string, password: string): Promise<LoginStep>;
  loginMfa(mfaToken: string, code: string): Promise<void>;
  /** Alta obligatoria del 2FA durante el login (admin sin 2FA): QR y secreto. */
  setupMfa(mfaToken: string): Promise<MfaEnrollment>;
  activateMfa(mfaToken: string, code: string): Promise<void>;
  logout(): Promise<void>;
  reloadProfile(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Renueva un minuto antes de que venza el access token (15 min). */
const REFRESH_MARGIN_S = 60;

export class NotStaffError extends ApiError {
  constructor() {
    super(403, 'NOT_STAFF', 'Esta cuenta no tiene acceso al backoffice. Usa la tienda para comprar.');
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<UserProfile | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Los permisos salen del token vigente: cada renovación los actualiza.
  useEffect(
    () =>
      onAccessTokenChange((token) => {
        setPermissions(token ? (decodeClaims(token)?.perms ?? []) : []);
      }),
    [],
  );

  const endSession = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setAccessToken(null);
    setUser(null);
    setStatus('guest');
  }, []);

  const schedule = useCallback(
    (expiresIn: number) => {
      if (timer.current) clearInterval(timer.current);
      timer.current = setInterval(
        async () => {
          if (!(await refreshSession())) endSession();
        },
        Math.max(expiresIn - REFRESH_MARGIN_S, 30) * 1000,
      );
    },
    [endSession],
  );

  /** Solo personal (staff): un cliente o un motorizado no entra al backoffice. */
  const loadProfile = useCallback(async () => {
    const token = getAccessToken();
    const claims = token ? decodeClaims(token) : null;
    if (!claims || claims.typ !== 'staff') {
      await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
      endSession();
      throw new NotStaffError();
    }
    const me = await api<UserProfile>('/me');
    setUser(me);
    setStatus('authenticated');
  }, [endSession]);

  const startSession = useCallback(
    async (token: AccessToken) => {
      setAccessToken(token.accessToken);
      schedule(token.expiresIn);
      await loadProfile();
    },
    [loadProfile, schedule],
  );

  // Al abrir la app: si la cookie de refresh sigue vigente, la sesión continúa sin pedir contraseña.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok = hasSessionHint() && (await refreshSession());
      if (cancelled) return;
      if (!ok) {
        setStatus('guest');
        return;
      }
      schedule(900);
      await loadProfile().catch(() => {
        if (!cancelled) setStatus('guest');
      });
    })();
    return () => {
      cancelled = true;
      if (timer.current) clearInterval(timer.current);
    };
  }, [loadProfile, schedule]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      permissions,
      async login(email, password) {
        const res = await api<AccessToken | MfaChallenge>('/auth/login', { method: 'POST', body: { email, password } });
        if ('mfaToken' in res) return res.mfaSetupRequired ? { kind: 'mfa-setup', mfaToken: res.mfaToken } : { kind: 'mfa', mfaToken: res.mfaToken };
        await startSession(res);
        return { kind: 'done' };
      },
      async loginMfa(mfaToken, code) {
        await startSession(await api<AccessToken>('/auth/login/mfa', { method: 'POST', body: { mfaToken, code } }));
      },
      setupMfa(mfaToken) {
        return api<MfaEnrollment>('/auth/mfa/setup', { method: 'POST', body: { mfaToken } });
      },
      async activateMfa(mfaToken, code) {
        await startSession(await api<AccessToken>('/auth/mfa/activate', { method: 'POST', body: { mfaToken, code } }));
      },
      async logout() {
        await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
        endSession();
      },
      reloadProfile: loadProfile,
    }),
    [status, user, permissions, startSession, loadProfile, endSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth fuera de <AuthProvider>');
  return ctx;
}

/** ¿El usuario tiene este permiso? (para mostrar u ocultar botones dentro de una pantalla). */
export function useCan(): (permission: string) => boolean {
  const { permissions } = useAuth();
  return useCallback((p: string) => permissions.includes(p), [permissions]);
}
