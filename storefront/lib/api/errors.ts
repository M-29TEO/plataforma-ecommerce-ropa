import type { ApiErrorBody } from '../types';

/** Error del API con el código de negocio (p. ej. CHECKOUT_TOTAL_CHANGED) para decidir qué mostrar. */
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

export async function toApiError(res: Response): Promise<ApiError> {
  let body: ApiErrorBody = {};
  try {
    body = (await res.json()) as ApiErrorBody;
  } catch {
    // Sin cuerpo JSON (p. ej. 502 del proxy).
  }
  const raw = body.error?.message ?? body.message;
  const message = Array.isArray(raw) ? raw.join('. ') : raw || defaultMessage(res.status);
  return new ApiError(res.status, body.error?.code ?? `HTTP_${res.status}`, message, body.error?.details ?? {});
}

function defaultMessage(status: number): string {
  if (status === 401) return 'Tu sesión expiró. Vuelve a iniciar sesión.';
  if (status === 403) return 'No tienes permiso para hacer esto.';
  if (status === 404) return 'No encontramos lo que buscas.';
  if (status === 429) return 'Demasiados intentos. Espera un momento y vuelve a intentar.';
  if (status >= 500) return 'Tuvimos un problema. Intenta de nuevo en unos segundos.';
  return 'No se pudo completar la operación.';
}
