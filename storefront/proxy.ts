import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/** Parámetros que cambian el contenido del listado (filtros, orden y página). */
const LISTING_PARAMS = ['talla', 'color', 'marca', 'genero', 'precio', 'ofertas', 'orden', 'pagina'];
const LISTING_PREFIXES = ['/tienda', '/categoria/', '/marca/', '/ofertas'];

/**
 * 1. Listados: la versión sin filtros (/categoria/mujer/vestidos) es estática con ISR, para SEO;
 *    con filtros, orden o página se reescribe a /filtrado/... que se renderiza en el servidor en
 *    cada petición (SSR). La URL que ve el visitante no cambia.
 * 2. Solo en desarrollo (DEV_API_PROXY=http://localhost:3000): /api/* va a la API agregando el
 *    tenant de la tienda, como hace Caddy en Docker. En Docker, Caddy atiende /api antes de llegar aquí.
 */
export function proxy(req: NextRequest) {
  const { pathname, searchParams } = req.nextUrl;

  if (pathname.startsWith('/api/')) {
    const target = process.env.DEV_API_PROXY;
    const tenant = process.env.STORE_TENANT_ID;
    if (!target || !tenant) return NextResponse.json({ error: { code: 'NO_API_PROXY', message: 'API no disponible' } }, { status: 502 });
    const headers = new Headers(req.headers);
    headers.set('x-tenant-id', tenant);
    const url = new URL(pathname.replace(/^\/api/, '') + req.nextUrl.search, target);
    return NextResponse.rewrite(url, { request: { headers } });
  }

  const isListing = LISTING_PREFIXES.some((p) => pathname === p.replace(/\/$/, '') || pathname.startsWith(p));
  if (isListing && LISTING_PARAMS.some((k) => searchParams.has(k))) {
    const url = req.nextUrl.clone();
    url.pathname = `/filtrado${pathname}`;
    return NextResponse.rewrite(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/api/:path*', '/tienda', '/categoria/:path*', '/marca/:path*', '/ofertas'],
};
