import { BROWSER_API, DEV_TENANT_ID } from '../config';
import { ApiError, toApiError } from './errors';

/**
 * Cliente del API para el navegador. El access token (15 min) vive SOLO en memoria: un XSS no lo
 * encuentra en localStorage. Se renueva con la cookie httpOnly `refresh_token` (Path=/api/v1/auth),
 * que el navegador manda sola con credentials: 'include'.
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
  return () => {
    listeners.delete(listener);
  };
}

function baseHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (DEV_TENANT_ID) h['X-Tenant-Id'] = DEV_TENANT_ID;
  return h;
}

/**
 * ¿Vale la pena renovar al abrir? El API deja la cookie no secreta `session_hint=1` junto a la de
 * refresh (que es httpOnly y no se ve desde aquí). Sin ella no hay sesión: no se llama a /auth/refresh.
 */
export function hasSessionHint(): boolean {
  return typeof document !== 'undefined' && document.cookie.split(/;\s*/).includes('session_hint=1');
}

/** Esperas antes de reintentar una renovación que falló por 429, 5xx o red (no por sesión inválida). */
const REFRESH_RETRY_MS = [1000, 3000];
const MAX_RETRY_AFTER_MS = 5000;

/**
 * Renueva el access token con la cookie de refresh (rotativa). Una sola renovación a la vez: rotar
 * dos veces el mismo refresh token se detecta como reutilización y cierra TODAS las sesiones.
 * Solo un 401/403 cierra la sesión; un 429, un 5xx o un corte de red se reintentan.
 */
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(`${BROWSER_API}/auth/refresh`, { method: 'POST', credentials: 'include', headers: baseHeaders() }).catch(() => null);
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

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Query string: se omiten los valores vacíos; los arreglos se mandan separados por coma. */
  query?: Record<string, string | number | boolean | readonly string[] | null | undefined>;
}

export function withQuery(path: string, query?: RequestOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length) params.set(k, v.join(','));
    } else params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path;
}

async function send(path: string, opts: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { ...baseHeaders(), ...opts.headers };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  return fetch(`${BROWSER_API}${withQuery(path, opts.query)}`, {
    method: opts.method ?? 'GET',
    headers,
    body,
    credentials: 'include',
    signal: opts.signal,
  });
}

/** Llamada con renovación automática: ante un 401 con sesión, renueva una vez y reintenta. */
async function request(path: string, opts: RequestOptions): Promise<Response> {
  let res = await send(path, opts);
  if (res.status === 401 && accessToken && !path.startsWith('/auth/')) {
    if (await refreshSession()) res = await send(path, opts);
  }
  if (!res.ok) throw await toApiError(res);
  return res;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await request(path, opts);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Descarga binaria autenticada (PDF, Excel, comprobantes): devuelve el Blob y el nombre sugerido. */
export async function apiBlob(path: string, opts: RequestOptions = {}): Promise<{ blob: Blob; filename: string | null }> {
  const res = await request(path, opts);
  const cd = res.headers.get('content-disposition') ?? '';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  return { blob: await res.blob(), filename: match ? decodeURIComponent(match[1]) : null };
}

/** Guarda un Blob como archivo en el equipo del usuario. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function isApiError(error: unknown, code?: string): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code);
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.name === 'AbortError') return '';
  return 'No hay conexión con el servidor. Revisa tu red.';
}
