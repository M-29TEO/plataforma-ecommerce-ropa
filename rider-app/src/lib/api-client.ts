import type { AccessToken } from './types';

/** Error de la API con el cuerpo estándar del backend: { error: { code, message, details } }. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Sin red, DNS o tiempo agotado: la petición no llegó a la API. */
export class NetworkError extends Error {
  constructor(message = 'Sin conexión con el servidor') {
    super(message);
    this.name = 'NetworkError';
  }
}

export interface TokenStore {
  get(): Promise<string | null>;
  set(token: string | null): Promise<void>;
}

export interface FileField {
  uri: string;
  name: string;
  type: string;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** JSON del cuerpo. */
  body?: unknown;
  /** multipart/form-data: valores de texto y archivos ({ uri, name, type } de React Native). */
  form?: Record<string, string | FileField | undefined>;
  /** false = ruta pública (login): sin Authorization ni reintento con refresh. */
  auth?: boolean;
  timeoutMs?: number;
}

export interface ApiClientDeps {
  baseUrl: string;
  tokens: TokenStore;
  fetch?: typeof fetch;
  /** El refresh falló (sesión vencida o revocada): la app vuelve al login. */
  onSessionExpired?: () => void;
}

export type ApiClient = <T>(path: string, options?: RequestOptions) => Promise<T>;

async function parseError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string | string[]; details?: Record<string, unknown> } } | null;
  const e = body?.error;
  const message = Array.isArray(e?.message) ? e.message.join('. ') : e?.message;
  return new ApiError(res.status, e?.code ?? `HTTP_${res.status}`, message ?? `Error ${res.status}`, e?.details ?? {});
}

/**
 * Cliente de la API. El access token (15 min) va en Authorization; al vencer (401), se renueva
 * con POST /auth/refresh: el refresh token viaja en la cookie httpOnly que guarda el almacén de
 * cookies nativo (OkHttp en Android), así nunca pasa por JavaScript. Un solo refresh a la vez.
 */
export function createApiClient(deps: ApiClientDeps): ApiClient {
  const doFetch = deps.fetch ?? fetch;
  let refreshing: Promise<string | null> | null = null;

  async function raw(path: string, options: RequestOptions, token: string | null): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let body: BodyInit | undefined;
    if (options.form) {
      const fd = new FormData();
      for (const [key, value] of Object.entries(options.form)) {
        if (value === undefined) continue;
        // React Native acepta { uri, name, type } como archivo en FormData.
        fd.append(key, value as unknown as Blob);
      }
      body = fd;
    } else if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
    try {
      return await doFetch(`${deps.baseUrl}${path}`, {
        method: options.method ?? (body ? 'POST' : 'GET'),
        headers,
        body,
        credentials: 'include',
        signal: controller.signal,
      });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      throw new NetworkError(name === 'AbortError' ? 'El servidor tardó demasiado en responder' : undefined);
    } finally {
      clearTimeout(timer);
    }
  }

  async function refresh(): Promise<string | null> {
    refreshing ??= (async () => {
      try {
        const res = await raw('/auth/refresh', { method: 'POST' }, null);
        if (!res.ok) return null;
        const access = (await res.json()) as AccessToken;
        await deps.tokens.set(access.accessToken);
        return access.accessToken;
      } catch {
        return null;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  return async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const auth = options.auth ?? true;
    let token = auth ? await deps.tokens.get() : null;
    let res = await raw(path, options, token);
    if (res.status === 401 && auth) {
      token = await refresh();
      if (!token) {
        await deps.tokens.set(null);
        deps.onSessionExpired?.();
        throw await parseError(res);
      }
      res = await raw(path, options, token);
    }
    if (!res.ok) throw await parseError(res);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  };
}

/** Mensaje para mostrar al motorizado. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof NetworkError) return error.message;
  return 'Ocurrió un error inesperado';
}
