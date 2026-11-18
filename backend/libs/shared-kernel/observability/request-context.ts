import { AsyncLocalStorage } from 'node:async_hooks';

/** Lo que el logger necesita del request en curso. req se lee al loguear: el guard fija req.user después. */
export interface RequestContext {
  requestId: string;
  req?: { user?: { id?: string; tenantId?: string } | null; headers?: Record<string, unknown> };
}

const storage = new AsyncLocalStorage<RequestContext>();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Corre fn (y todo lo asíncrono que dispare) con el contexto del request. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** request_id, tenant_id y user_id del request en curso (los vacíos no aparecen). */
export function requestLogFields(): Record<string, string> {
  const ctx = storage.getStore();
  if (!ctx) return {};
  const out: Record<string, string> = { request_id: ctx.requestId };
  const user = ctx.req?.user;
  // Sin usuario, el tenant es el de X-Tenant-Id (lo fija Caddy); solo si es un uuid: es texto del cliente.
  const tenant = user?.tenantId ?? ctx.req?.headers?.['x-tenant-id'];
  if (typeof tenant === 'string' && UUID_RE.test(tenant)) out.tenant_id = tenant;
  if (user?.id) out.user_id = user.id;
  return out;
}
