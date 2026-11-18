import * as SecureStore from 'expo-secure-store';
import { createApiClient, FileField, TokenStore } from './api-client';
import { API_URL } from './config';
import type {
  AccessToken,
  CodMethod,
  Earnings,
  GeoPoint,
  LocationAck,
  MfaChallenge,
  Offer,
  Presence,
  RiderProfile,
  RiderSettableStatus,
  RiderShipment,
  Shift,
  ShiftEndResult,
} from './types';

const TOKEN_KEY = 'moda.rider.access';

/**
 * El access token se guarda en el almacén cifrado del sistema (Keystore) además de en memoria: la
 * tarea de GPS en segundo plano puede correr en un proceso nuevo, sin la pantalla abierta.
 */
let memoryToken: string | null | undefined;
export const tokenStore: TokenStore = {
  async get() {
    if (memoryToken === undefined) memoryToken = await SecureStore.getItemAsync(TOKEN_KEY).catch(() => null);
    return memoryToken ?? null;
  },
  async set(token) {
    memoryToken = token;
    if (token) await SecureStore.setItemAsync(TOKEN_KEY, token);
    else await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => undefined);
  },
};

const expiredListeners = new Set<() => void>();
export function onSessionExpired(listener: () => void): () => void {
  expiredListeners.add(listener);
  return () => expiredListeners.delete(listener);
}

export const request = createApiClient({
  baseUrl: API_URL,
  tokens: tokenStore,
  onSessionExpired: () => expiredListeners.forEach((l) => l()),
});

export const api = {
  // ---------------------------------------------------------------- Sesión
  login: (email: string, password: string) =>
    request<AccessToken | MfaChallenge>('/auth/login', { body: { email, password }, auth: false }),
  loginMfa: (mfaToken: string, code: string) => request<AccessToken>('/auth/login/mfa', { body: { mfaToken, code }, auth: false }),
  logout: () => request<void>('/auth/logout', { method: 'POST', auth: false }),

  // ---------------------------------------------------------------- Perfil y turno
  me: () => request<RiderProfile>('/rider/me'),
  startShift: (at: GeoPoint | null) => request<Shift>('/rider/shift/start', { body: at ?? {} }),
  endShift: () => request<ShiftEndResult>('/rider/shift/end', { method: 'POST' }),
  setPresence: (presence: Presence) => request<{ riderId: string; presence: Presence }>('/rider/presence', { body: { presence } }),

  // ---------------------------------------------------------------- Ofertas
  offers: () => request<Offer[]>('/rider/offers'),
  acceptOffer: (id: string) => request<RiderShipment>(`/rider/offers/${encodeURIComponent(id)}/accept`, { method: 'POST' }),
  rejectOffer: (id: string, reason?: string) => request<void>(`/rider/offers/${encodeURIComponent(id)}/reject`, { body: reason ? { reason } : {} }),

  // ---------------------------------------------------------------- Envíos
  shipments: () => request<RiderShipment[]>('/rider/shipments'),
  shipment: (id: string) => request<RiderShipment>(`/rider/shipments/${encodeURIComponent(id)}`),
  setStatus: (id: string, status: RiderSettableStatus, at: GeoPoint | null, reason?: string) =>
    request<{ id: string; status: string }>(`/rider/shipments/${encodeURIComponent(id)}/status`, {
      body: { status, ...(at ?? {}), ...(reason ? { reason } : {}) },
    }),
  deliver: (id: string, input: DeliverInput) =>
    request<RiderShipment>(`/rider/shipments/${encodeURIComponent(id)}/deliver`, {
      form: {
        lat: String(input.at.lat),
        lng: String(input.at.lng),
        receiverName: input.receiverName,
        otp: input.otp,
        codCollected: input.codCollected,
        codMethod: input.codMethod,
        photo: input.photo,
        signature: input.signature,
      },
      timeoutMs: 60_000,
    }),

  // ---------------------------------------------------------------- GPS y ganancias
  location: (p: { lat: number; lng: number; heading?: number; speedKmh?: number; accuracyM?: number; recordedAt: string }) =>
    request<LocationAck>('/rider/location', { body: p }),
  earnings: (from?: string, to?: string) => {
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    const qs = q.toString();
    return request<Earnings>(`/rider/earnings${qs ? `?${qs}` : ''}`);
  },
};

export interface DeliverInput {
  at: GeoPoint;
  receiverName: string;
  otp?: string;
  codCollected?: string;
  codMethod?: CodMethod;
  photo: FileField;
  signature: FileField;
}
