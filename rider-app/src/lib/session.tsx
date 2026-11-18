import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { api, onSessionExpired, tokenStore } from './api';
import { ApiError } from './api-client';
import { offerEvents } from './events';
import { currentPoint, ensureLocationPermissions, PermissionProblem, startShiftTracking, stopShiftTracking } from './location-task';
import { notifyNewOffer, setupNotifications } from './notifications';
import { subscribeNtfy } from './ntfy';
import type { AccessToken, MfaChallenge, RiderProfile, ShiftEndResult } from './types';

type Status = 'loading' | 'signed-out' | 'signed-in';

interface SessionValue {
  status: Status;
  profile: RiderProfile | null;
  ntfyConnected: boolean;
  /** null = sesión iniciada; string = falta el código 2FA (mfaToken). */
  login(email: string, password: string): Promise<string | null>;
  loginMfa(mfaToken: string, code: string): Promise<void>;
  logout(): Promise<void>;
  refreshProfile(): Promise<RiderProfile | null>;
  /** null si arrancó; si no, qué permiso falta. */
  startShift(): Promise<PermissionProblem>;
  endShift(): Promise<ShiftEndResult>;
}

const SessionContext = createContext<SessionValue | null>(null);

export class NotRiderError extends Error {
  constructor() {
    super('Esta app es solo para motorizados. Usa el backoffice o la tienda con esta cuenta.');
  }
}

/**
 * Sesión del motorizado y su turno. Con el turno activo: GPS en segundo plano (location-task) y
 * suscripción a su tópico de ntfy para las ofertas. Al reabrir la app con un turno activo (el
 * teléfono se reinició, Android cerró el proceso) se reanudan ambos.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [profile, setProfile] = useState<RiderProfile | null>(null);
  const [ntfyConnected, setNtfyConnected] = useState(false);
  const mounted = useRef(true);

  const signOutLocal = useCallback(async () => {
    await stopShiftTracking().catch(() => undefined);
    await tokenStore.set(null);
    setProfile(null);
    setStatus('signed-out');
  }, []);

  const loadProfile = useCallback(async (): Promise<RiderProfile> => {
    try {
      return await api.me();
    } catch (error) {
      // 403: la cuenta existe pero no es de motorizado; 404: no tiene ficha de motorizado activa.
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) throw new NotRiderError();
      throw error;
    }
  }, []);

  const refreshProfile = useCallback(async () => {
    try {
      const p = await loadProfile();
      if (mounted.current) setProfile(p);
      return p;
    } catch (error) {
      if (error instanceof NotRiderError) await signOutLocal();
      return null;
    }
  }, [loadProfile, signOutLocal]);

  // Arranque: ¿hay sesión guardada?
  useEffect(() => {
    mounted.current = true;
    (async () => {
      if (!(await tokenStore.get())) return setStatus('signed-out');
      const p = await refreshProfile();
      setStatus(p ? 'signed-in' : 'signed-out');
    })();
    const off = onSessionExpired(() => void signOutLocal());
    return () => {
      mounted.current = false;
      off();
    };
  }, [refreshProfile, signOutLocal]);

  const shiftActive = profile?.shift?.status === 'active';

  // Turno activo: GPS en segundo plano (idempotente si ya corría).
  useEffect(() => {
    if (status !== 'signed-in') return;
    if (shiftActive) void startShiftTracking().catch(() => undefined);
    else void stopShiftTracking().catch(() => undefined);
  }, [status, shiftActive]);

  // Turno activo: ofertas por ntfy.
  const ntfyUrl = profile?.ntfy.url;
  const ntfyTopic = profile?.ntfy.topic;
  useEffect(() => {
    if (status !== 'signed-in' || !shiftActive || !ntfyUrl || !ntfyTopic) return;
    return subscribeNtfy({
      url: ntfyUrl,
      topic: ntfyTopic,
      onStateChange: setNtfyConnected,
      onMessage: (m) => {
        offerEvents.emit({ source: 'ntfy' });
        void notifyNewOffer(m.title, m.message);
      },
    });
  }, [status, shiftActive, ntfyUrl, ntfyTopic]);

  // Al volver a primer plano: perfil al día (saldo de efectivo, turno).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active' && status === 'signed-in') void refreshProfile();
    });
    return () => sub.remove();
  }, [status, refreshProfile]);

  const finishLogin = useCallback(
    async (access: AccessToken) => {
      await tokenStore.set(access.accessToken);
      try {
        setProfile(await loadProfile());
        setStatus('signed-in');
        void setupNotifications().catch(() => undefined);
      } catch (error) {
        await api.logout().catch(() => undefined);
        await tokenStore.set(null);
        throw error;
      }
    },
    [loadProfile],
  );

  const value = useMemo<SessionValue>(
    () => ({
      status,
      profile,
      ntfyConnected,
      async login(email, password) {
        const res = await api.login(email.trim(), password);
        if ('mfaToken' in res) {
          if ((res as MfaChallenge).mfaSetupRequired) throw new Error('Tu cuenta debe activar el 2FA desde el backoffice antes de usar la app.');
          return (res as MfaChallenge).mfaToken;
        }
        await finishLogin(res as AccessToken);
        return null;
      },
      async loginMfa(mfaToken, code) {
        await finishLogin(await api.loginMfa(mfaToken, code));
      },
      async logout() {
        if (profile?.shift?.status === 'active') throw new Error('Termina tu turno antes de cerrar sesión.');
        await api.logout().catch(() => undefined);
        await signOutLocal();
      },
      refreshProfile,
      async startShift() {
        const problem = await ensureLocationPermissions();
        if (problem) return problem;
        await setupNotifications().catch(() => undefined);
        const at = await currentPoint(60_000);
        await api.startShift(at);
        await startShiftTracking();
        await refreshProfile();
        return null;
      },
      async endShift() {
        const result = await api.endShift();
        await stopShiftTracking();
        await refreshProfile();
        return result;
      },
    }),
    [status, profile, ntfyConnected, finishLogin, refreshProfile, signOutLocal],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession fuera de SessionProvider');
  return ctx;
}
