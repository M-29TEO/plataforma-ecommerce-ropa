# Backoffice (Next.js 16)

Panel del personal en **`/admin`**. Va detrás de Caddy en el mismo dominio que la tienda, la API (`/api`)
y el tiempo real (`/ws`): no hay CORS, el access token vive solo en memoria y la sesión se renueva con la
cookie httpOnly `refresh_token` (`Path=/api/v1/auth`). Todas las pantallas son de cliente: los datos son
privados y por usuario, así que no se renderiza nada con datos en el servidor ni se cachea.

## Menú según permisos

`lib/permissions.ts` declara cada pantalla con los permisos que necesita (`all` o `any`). Con los permisos
del JWT (claim `perms`) se arman el menú, la página de inicio y el guard de cada ruta
(`app/(panel)/layout.tsx`): sin permiso se muestra un aviso 403 sin pedir datos al API. Es solo
experiencia de uso: **la API vuelve a verificar cada permiso en cada llamada**. Un cambio de rol rige en el
siguiente login o renovación del token (≤ 15 min).

| Área | Pantallas | Permiso | Roles del seed |
|---|---|---|---|
| Administración | Productos y variantes (generador color × talla, escaneo del código, fotos), Precios masivos | `catalog.product.write` | admin, gerente, vendedor |
| | Usuarios (alta de staff con contraseña temporal, bloqueo, reset de contraseña y 2FA, roles) | `iam.users.read` (+ `write`, `iam.roles.assign`) | admin (gerente solo lectura) |
| | Roles y permisos (matriz) | `iam.roles.read` | admin, gerente |
| | Zonas de cobertura dibujadas en el mapa (terra-draw) y franjas | `logistics.zone.write` | admin, logística |
| Gerencia | Dashboard de KPIs (ventas, margen, conversión, entregas) | `reports.*.read` (alguno) | admin, gerente, logística (entregas) |
| | Exportes Excel/PDF | `reports.export` | admin, gerente |
| Bodega | Picking con escaneo por cámara | `inventory.picking` | admin, bodega |
| | Recepción de compras, Ajustes, Stock | `inventory.purchase.receive`, `inventory.adjust`, `inventory.read` | admin, bodega (stock: también vendedor, gerente y logística) |
| Ventas | Pedidos asistidos | `orders.assisted.create` | admin, vendedor |
| | Pedidos (listado, detalle, cambio de estado según la máquina de estados) | `orders.read` | todos los de staff |
| | Devoluciones (cola por estado, aprobar/rechazar, recibir, inspeccionar, aprobar reembolso, nota de crédito; registro desde el pedido) | `returns.read` (+ `returns.approve`, `returns.inspect`, `payments.refund.approve`, `billing.read`) | admin, gerente, soporte, bodega (recibe e inspecciona) |
| Soporte | Tickets con SLA, respuestas y notas internas | `support.tickets.read` | admin, gerente (lectura), soporte |
| Logística | Mapa en vivo, Despacho, Liquidaciones, Conciliación de transferencias | `logistics.read`, `logistics.dispatch`, `logistics.settlement.*`, `payments.transfer.verify` | admin, logística (despacho también bodega; liquidaciones también gerente) |

El rol **Logística** (`logistics`, "Coordinador de logística") se agregó con el backoffice: el enunciado no
lo nombra, pero el mapa en vivo, el despacho, las liquidaciones y la conciliación son un puesto propio.

## Decisiones

- **2FA obligatorio para admin.** El login es en dos pasos (`/auth/login` → `/auth/login/mfa`). Un admin
  sin 2FA lo configura en el mismo login (QR + primer código, `/auth/mfa/setup` y `/auth/mfa/activate`):
  el API no le abre sesión sin eso. Cualquier usuario puede activarlo en *Mi cuenta*. Solo staff: una
  cuenta de cliente o motorizado se rechaza y se cierra su sesión.
- **Escaneo de códigos de barras** (`components/scanner/BarcodeScanner.tsx`): `BarcodeDetector` nativo si
  existe; si no, `@zxing/browser`. Siempre hay entrada manual, que también sirve con lectores USB/Bluetooth.
  La cámara exige HTTPS o `localhost`. `Permissions-Policy: camera=(self)`.
- **Tiempo real del staff** (`lib/realtime.ts`): Socket.IO en el namespace `/staff` con el access token en
  el handshake; al vencer (`TOKEN_EXPIRED`) se renueva y reconecta, y se vuelve a pedir el estado (los
  eventos perdidos no se reenvían). Si el socket cae, se consulta por HTTP cada 30 s.
- **Conciliación de transferencias**: el extracto CSV del banco se lee **en el navegador** (papaparse) y no
  se sube a ningún lado; `lib/reconciliation.ts` empareja por referencia esperada + monto (exacto) o por
  monto + referencia del cliente / fecha ± 3 días (probable).
- **Concurrencia optimista**: productos con `expectedUpdatedAt`, tickets y pedidos con `version`; un 409
  avisa y recarga sin perder lo tecleado.
- **Mapas**: MapLibre con teselas OSM en desarrollo o PMTiles de Ecuador servidas por Caddy
  (`NEXT_PUBLIC_MAP_TILES=pmtiles`), igual que la tienda.

## Desarrollo

Necesita la API y el realtime del backend, y el `tenantId` que imprime `npm run seed:dev`.

```bash
# backend/.env: REFRESH_COOKIE_PATH=/api/v1/auth
cd backend && npm run dev:api        # :3000
cd backend && npm run dev:realtime   # :3002

cd backoffice
npm install
# .env.local
#   DEV_API_PROXY=http://localhost:3000               # next.config.ts reescribe /api/* → API (lo que hace Caddy)
#   NEXT_PUBLIC_DEV_TENANT_ID=<tenantId del seed>     # tenant del login (en Docker lo fija Caddy)
#   NEXT_PUBLIC_REALTIME_URL=http://localhost:3002
npm run dev                          # http://localhost:3200/admin
```

Usuarios del seed (contraseña `Demo-2026-segura`): `admin@demo.test` (2FA con el secreto que imprime el
seed), `gerente@`, `vendedor@`, `bodega@`, `soporte@` y `logistica@demo.test`.

## Pruebas

```bash
npm test             # Vitest: permisos y menú, token, formatos, catálogo, picking, escáner, pedidos, asistidos, reportes, soporte, devoluciones, logística, conciliación
npm run typecheck
npm run lint
```

**E2E (Playwright en su contenedor oficial; no instala navegadores en el equipo).** Contra un backoffice
compilado (`next build && next start -p 3200`) con la API y el realtime levantados y sembrados. Para varios
logins seguidos desde la misma IP, la API de pruebas va con `RATE_LIMIT_ENABLED=false` (el perfil `auth`
limita los intentos de login):

```bash
docker run --rm --add-host=host.docker.internal:host-gateway --ipc=host -v "$(pwd -W):/work" -w /work \
  -e E2E_BASE_URL=http://localhost:3200 mcr.microsoft.com/playwright:v1.63.0-noble \
  sh -c "node e2e/forward.mjs 3200 3002 & sleep 1; node node_modules/@playwright/test/cli.js test"
```

Cubre: login del admin con contraseña + TOTP, menú completo del admin, menú de bodega sin pantallas de
admin y 403 al forzar `/admin/usuarios`, cola de picking, pedidos asistidos del vendedor, dashboard del
gerente, tickets de soporte, mapa en vivo conectado por Socket.IO para logística y rechazo de una cuenta
de cliente.

## Docker

Perfil `backoffice` de `docker-compose.yml` (junto con `front`, que trae Caddy, la API y el realtime):

```bash
docker compose --profile front --profile backoffice --profile sims up -d --build   # http://localhost/admin
```

Caddy enruta `/admin*` sin quitar el prefijo (`basePath: '/admin'`). Las fotos de producto subidas desde
aquí se sirven en `/media/products/*` (Caddy → `GET /v1/catalog/media/...` de la API).
