import { BROWSER_API } from '../config';
import { ApiError, toApiError } from './errors';

/**
 * Llamadas al API desde el navegador. Mismo dominio (Caddy): las cookies httpOnly (refresh_token,
 * cart_token) viajan solas con credentials: 'include'. El access token vive SOLO en memoria (no en
 * localStorage, para que un XSS no lo robe) y se renueva con la cookie de refresh.
 */

export interface AccessToken {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
const listeners = new Set<(token: string | null) => void>();

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
  for (const l of listeners) l(token);
}

export function onAccessTokenChange(listener: (token: string | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * ¿Vale la pena renovar al abrir? El API deja la cookie no secreta `session_hint=1` junto a la de
 * refresh (httpOnly, invisible aquí). Sin ella el visitante es anónimo: no se llama a /auth/refresh.
 */
export function hasSessionHint(): boolean {
  return typeof document !== 'undefined' && document.cookie.split(/;\s*/).includes('session_hint=1');
}

/** Esperas antes de reintentar una renovación que falló por 429, 5xx o red (no por sesión inválida). */
const REFRESH_RETRY_MS = [1000, 3000];
const MAX_RETRY_AFTER_MS = 5000;

/**
 * Renueva el access token con la cookie de refresh (rotativa). Una sola petición a la vez: si varias
 * llamadas reciben 401 juntas, todas esperan la misma renovación (rotar dos veces el mismo refresh
 * token se detecta como reutilización y cierra todas las sesiones).
 * Solo un 401/403 cierra la sesión; un 429, un 5xx o un corte de red se reintentan.
 */
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(`${BROWSER_API}/auth/refresh`, { method: 'POST', credentials: 'include' }).catch(() => null);
        if (res?.ok) {
          const body = (await res.json()) as AccessToken;
          setAccessToken(body.accessToken);
          return true;
        }
        if (res && res.status !== 429 && res.status < 500) {
          setAccessToken(null);
          return false;
        }
        if (attempt >= REFRESH_RETRY_MS.length) return false;
        await sleep(retryAfterMs(res) ?? REFRESH_RETRY_MS[attempt]);
      }
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

function retryAfterMs(res: Response | null): number | null {
  const seconds = Number(res?.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const send = () => {
    const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    let body: BodyInit | undefined;
    if (opts.form) body = opts.form;
    else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    return fetch(`${BROWSER_API}${path}`, { method: opts.method ?? 'GET', headers, body, credentials: 'include', signal: opts.signal });
  };

  let res = await send();
  // Token vencido (15 min): se renueva una vez y se reintenta.
  if (res.status === 401 && accessToken && !path.startsWith('/auth/')) {
    if (await refreshSession()) res = await send();
  }
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function isApiError(error: unknown, code?: string): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code);
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.name === 'AbortError') return '';
  return 'No pudimos conectar con la tienda. Revisa tu conexión.';
}
