# Storefront (Next.js 16 · PWA)

Tienda en línea que consume la API del backend (`/v1`). Va detrás de Caddy en el mismo dominio que
la API (`/api`) y el tiempo real (`/ws`), así que no hay CORS ni tokens en `localStorage`.

## Qué incluye

| Área | Rutas | Render |
|---|---|---|
| Home (novedades, ofertas, marcas) | `/` | SSR con datos del API en caché 5 min |
| Listados con filtros por **talla, color, precio y marca** (y género, ofertas) | `/categoria/<ruta>`, `/marca/<slug>`, `/tienda`, `/ofertas` | **ISR** sin filtros (canónica, se indexa) · **SSR** con filtros (`proxy.ts` reescribe a `/filtrado/...`, `noindex,follow`) |
| Ficha de producto: galería por color con zoom, color/talla con stock, **guía de tallas**, reseñas y preguntas | `/producto/<slug>` | **ISR** 5 min, JSON-LD `Product` + `BreadcrumbList` |
| Búsqueda con sugerencias mientras se escribe | `/buscar?q=` | SSR |
| Carrito (cupones, avisos de precio y stock) | drawer y `/carrito` | Cliente |
| Checkout **invitado o registrado**: dirección con pin en **MapLibre** (GPS, geocodificación con Nominatim para clientes), **franja horaria**, factura (cédula/RUC validados), pago | `/checkout` | Cliente |
| Pago con la **pasarela simulada** y resultado (consulta con el secreto del pago; transferencia con comprobante) | `/checkout/resultado?paymentId=` | Cliente |
| Mi cuenta: resumen + **Web Push**, mis pedidos (detalle, cancelar, factura RIDE), **devoluciones y cambios de talla** (RMA con fotos, dentro de 30 días desde la entrega), direcciones (pin en el mapa), favoritos con alertas, privacidad LOPDP | `/mi-cuenta/...` | Cliente |
| **Tracking en vivo**: el motorizado se mueve en el mapa (Socket.IO), ETA, línea de tiempo | `/seguimiento/<token>` | Cliente |
| PWA: manifest, service worker (sin conexión, caché de estáticos, push), instalar | `/manifest.webmanifest`, `/sw.js` | — |
| SEO: `sitemap.xml`, `robots.txt`, canónicas, Open Graph | | — |

Las rutas `/seguimiento/<token>`, `/carrito`, `/checkout/resultado` y `/mi-cuenta/privacidad` son las
que ya usan los emails y push del backend (Notificaciones) y el `PAYMENT_RETURN_URL`.

### Decisiones

- **ISR + SSR del catálogo sin depender de la API en el build.** `generateStaticParams` devuelve `[]`:
  cada categoría y ficha se genera en la primera visita y se regenera cada 5 min. La imagen Docker se
  construye sin API.
- **Filtros en la URL en español** (`?talla=S,M&color=Negro&marca=costa-azul&precio=20-60&orden=precio-asc`),
  traducidos al API en `lib/filters.ts`. Las facetas del API son disyuntivas: cada una cuenta ignorando
  su propio filtro.
- **Sesión**: access token (15 min) solo en memoria; la renovación usa la cookie httpOnly `refresh_token`
  (`Path=/api/v1/auth`). El carrito de invitado (cookie `cart_token`) se fusiona al iniciar sesión.
- **Mapa**: `NEXT_PUBLIC_MAP_TILES=pmtiles` usa `/tiles/ecuador.pmtiles` (Caddy) con el estilo de Protomaps;
  `osm` (por defecto) usa teselas raster de openstreetmap.org **solo para desarrollo** (su política no
  admite tráfico de producción). Genera el `.pmtiles` según `docs/02-stack-open-source.md`.
- **Tiempo real**: `socket.io-client` contra `apps/realtime` (`/ws/socket.io`), con el token de
  seguimiento en el handshake. Si el socket cae, se consulta por HTTP cada 30 s.
- **Web Push**: clave VAPID de `GET /v1/notifications/push/public-key`; la suscripción se manda sin
  `expirationTime` (el API rechaza campos extra). En iPhone solo funciona con la app instalada.
- **Fotos de demo**: ilustraciones SVG propias (`npm run images:demo` → `public/media/demo`), sin
  fotos de terceros. `CATALOG_MEDIA_BASE_URL` del backend es `/media`.
- Sin retiro en tienda en el checkout: el API no expone puntos de retiro públicos todavía.

## Desarrollo

Necesita la API (`npm run dev:api`), el worker y el realtime del backend, y el `STORE_TENANT_ID`
que imprime `npm run seed:dev`.

```bash
# backend/.env: REFRESH_COOKIE_PATH=/api/v1/auth y PAYMENT_RETURN_URL=http://localhost:3100/checkout/resultado
cd backend && npm run dev:api        # :3000
cd backend && npm run dev:worker
cd backend && npm run dev:realtime   # :3002

cd storefront
npm install
# .env.local
#   STORE_TENANT_ID=<tenantId del seed>
#   DEV_API_PROXY=http://localhost:3000          # proxy.ts: /api/* → API con X-Tenant-Id (lo que hace Caddy)
#   API_INTERNAL_URL=http://localhost:3000/v1     # SSR
#   NEXT_PUBLIC_REALTIME_URL=http://localhost:3002
npm run dev                          # http://localhost:3100
```

Simular al motorizado de un pedido con entrega por motorizado (desde `backend/`):
`npm run sim:rider -- <número de pedido>` y abrir el enlace de seguimiento.

## Pruebas

```bash
npm test             # Vitest: filtros, formatos, checkout (cédula/RUC, totales), variantes, tracking, devoluciones
npm run typecheck
npm run lint
```

**E2E (Playwright, en su contenedor oficial: no instala navegadores en el equipo).** Con el storefront
(`next build && next start -p 3100`), la API, el realtime y la pasarela simulada levantados en el equipo:

```bash
docker run --rm --add-host=host.docker.internal:host-gateway --ipc=host -v "$(pwd -W):/work" -w /work \
  -e E2E_BASE_URL=http://localhost:3100 -e E2E_ORDER_FILE=/work/e2e-out/order.txt \
  mcr.microsoft.com/playwright:v1.63.0-noble \
  sh -c "node e2e/forward.mjs 3100 3002 8081 & sleep 1; node node_modules/@playwright/test/cli.js test"
```

`e2e/forward.mjs` publica esos puertos como `localhost` dentro del contenedor (contexto seguro: GPS y
service worker). La compra como invitado escribe el número de pedido en `e2e-out/order.txt`; en otra
terminal, `npm run sim:rider -- $(cat ../storefront/e2e-out/order.txt)` mueve al motorizado y la prueba
espera a verlo en el mapa hasta «Tu pedido fue entregado».

## Docker

Perfil `front` de `docker-compose.yml` (WAF + Caddy + web + api + worker + realtime):

```bash
docker compose --profile front --profile sims up -d --build   # http://localhost
```
