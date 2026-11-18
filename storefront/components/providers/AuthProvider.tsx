'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { type AccessToken, api, hasSessionHint, refreshSession, setAccessToken } from '@/lib/api/client';
import type { MfaChallenge, UserProfile } from '@/lib/commerce-types';

type Status = 'loading' | 'guest' | 'authenticated';

export interface RegisterInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phone: string;
  consents: { terms: boolean; privacy: boolean; marketingEmail?: boolean; marketingWhatsapp?: boolean; marketingSms?: boolean };
}

interface AuthContextValue {
  status: Status;
  user: UserProfile | null;
  /** Devuelve el desafío de 2FA si la cuenta lo tiene activo. */
  login(email: string, password: string): Promise<MfaChallenge | null>;
  loginMfa(mfaToken: string, code: string): Promise<void>;
  register(input: RegisterInput): Promise<void>;
  logout(): Promise<void>;
  reload(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Renueva un minuto antes de que venza el access token (15 min). */
const REFRESH_MARGIN_S = 60;

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<UserProfile | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  /** Renueva cada (vigencia - 1 min); si la cookie ya no sirve, la sesión termina. */
  const schedule = useCallback((expiresIn: number) => {
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(async () => {
      if (!(await refreshSession())) {
        if (timer.current) clearInterval(timer.current);
        setUser(null);
        setStatus('guest');
      }
    }, Math.max(expiresIn - REFRESH_MARGIN_S, 30) * 1000);
  }, []);

  const loadProfile = useCallback(async () => {
    const me = await api<UserProfile>('/me');
    // El storefront es para clientes: una sesión de staff o motorizado no se usa aquí.
    if (me.type !== 'customer') {
      setAccessToken(null);
      setUser(null);
      setStatus('guest');
      return;
    }
    setUser(me);
    setStatus('authenticated');
  }, []);

  const startSession = useCallback(
    async (token: AccessToken) => {
      setAccessToken(token.accessToken);
      schedule(token.expiresIn);
      await loadProfile();
      // El carrito de invitado (cookie) pasa al del cliente.
      await api('/cart/merge', { method: 'POST' }).catch(() => undefined);
    },
    [loadProfile, schedule],
  );

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
      await loadProfile().catch(() => setStatus('guest'));
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
      async login(email, password) {
        const res = await api<AccessToken | MfaChallenge>('/auth/login', { method: 'POST', body: { email, password } });
        if ('mfaToken' in res) return res;
        await startSession(res);
        return null;
      },
      async loginMfa(mfaToken, code) {
        await startSession(await api<AccessToken>('/auth/login/mfa', { method: 'POST', body: { mfaToken, code } }));
      },
      async register(input) {
        // El registro no abre sesión: se inicia con las mismas credenciales.
        await api<UserProfile>('/auth/register', { method: 'POST', body: input });
        const res = await api<AccessToken | MfaChallenge>('/auth/login', { method: 'POST', body: { email: input.email, password: input.password } });
        if (!('mfaToken' in res)) await startSession(res);
      },
      async logout() {
        await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
        if (timer.current) clearInterval(timer.current);
        setAccessToken(null);
        setUser(null);
        setStatus('guest');
      },
      reload: loadProfile,
    }),
    [status, user, startSession, loadProfile],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth fuera de <AuthProvider>');
  return ctx;
}
