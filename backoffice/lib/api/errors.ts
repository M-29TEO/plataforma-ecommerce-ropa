/** Cuerpo de error del API: `{ error: { code, message, details } }` (o el de Nest para 400 de validación). */
interface ApiErrorBody {
  error?: { code?: string; message?: string | string[]; details?: Record<string, unknown> };
  message?: string | string[];
}

/** Error del API con su código de negocio (p. ej. STALE_PRODUCT) para decidir qué mostrar. */
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

export function defaultMessage(status: number): string {
  if (status === 401) return 'Tu sesión expiró. Vuelve a iniciar sesión.';
  if (status === 403) return 'Tu rol no tiene permiso para esta acción.';
  if (status === 404) return 'No se encontró el registro.';
  if (status === 409) return 'Alguien más modificó este registro. Recarga e intenta de nuevo.';
  if (status === 429) return 'Demasiados intentos. Espera un momento.';
  if (status >= 500) return 'El servidor tuvo un problema. Intenta de nuevo en unos segundos.';
  return 'No se pudo completar la operación.';
}
