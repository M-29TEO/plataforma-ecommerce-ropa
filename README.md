# Plataforma e-commerce de moda (Ecuador)

Plataforma completa de comercio electrónico para una tienda de moda en Ecuador: tienda web (PWA), panel
de administración por roles, app Android para motorizados y backend modular con facturación electrónica SRI,
logística con tracking en vivo, pagos, CRM, reportes, seguridad (OWASP/LOPDP) y CI/CD. Stack 100 % open source.

**Tecnologías:** TypeScript · NestJS · Next.js 16 · React Native (Expo) · PostgreSQL 16 + PostGIS · Valkey/BullMQ ·
Socket.IO · MapLibre + OpenStreetMap · OpenTelemetry + Grafana · Docker Compose · Caddy + ModSecurity · Woodpecker CI.

**Arquitectura:** monolito modular con capas hexagonales (api / application / domain / infrastructure), un schema de
PostgreSQL por módulo, eventos de dominio con transactional outbox y simuladores en contenedores para los servicios
externos (pasarela de pago, courier, SRI). Detalle en [docs/01-arquitectura-c4.md](docs/01-arquitectura-c4.md).

**Por dónde empezar a revisar:** [docs/DEMO.md](docs/DEMO.md) (guion de demo de punta a punta),
[backend/libs/modules](backend/libs/modules) (módulos de negocio con sus tests) y [docs/07-seguridad.md](docs/07-seguridad.md).

## Contenido
- `docs/` — enunciado, arquitectura C4 y ADRs, stack, modelo de datos, seguridad OWASP/LOPDP (`07-seguridad.md`), despliegue, CI/CD, backups y DRP (`08-despliegue.md`) y guion de demo (`DEMO.md`)
- `docker-compose.yml` — infraestructura local con perfiles
- `infra/` — Caddyfile, datos de mapas (OSRM, PMTiles)
- `storefront/` — tienda Next.js 16 (PWA): catálogo con SSR/ISR, filtros, ficha con guía de tallas, búsqueda, carrito, checkout invitado o registrado con mapa MapLibre y franja, pago simulado, mis pedidos, tracking en vivo, wishlist, reseñas y Web Push. Ver `storefront/README.md`
- `backoffice/` — backoffice Next.js 16 en `/admin` con menú según permisos: administración (productos, variantes, precios, usuarios, roles, zonas dibujadas en el mapa), gerencia (KPIs y exportes), bodega (picking con escaneo por cámara, recepciones, ajustes, stock), ventas (pedidos asistidos), soporte (tickets) y logística (mapa en vivo, despacho, liquidaciones, conciliación de transferencias); 2FA obligatorio para admin. Ver `backoffice/README.md`
- `rider-app/` — app Android del motorizado (React Native + Expo 57): login, inicio y fin de turno, GPS cada 10 s en segundo plano, ofertas por ntfy (aceptar o rechazar), mapa MapLibre, botón de navegación, estados del envío, prueba de entrega (foto, firma en pantalla y OTP), cobro contra entrega y ganancias. APK con `npm run build:apk` (expo prebuild + Gradle en un contenedor). Ver `rider-app/README.md`
- `backend/` — NestJS (API + worker + realtime Socket.IO). Módulos implementados: Inventario, Pedidos, Promociones, Carrito, Checkout, Pagos, Logística (cotización, calificaciones y liquidaciones de motorizados), Facturación electrónica SRI, Devoluciones y reembolsos, CRM y Fidelización (direcciones con Nominatim, wishlist, puntos, niveles y referidos), Catálogo (catálogo público con facetas y búsqueda, reseñas y preguntas), tracking en vivo del motorizado, Notificaciones, Soporte y Reportes (KPIs del gerente con vistas materializadas y exportes Excel/PDF). Ver `backend/README.md`
- `simulators/payments/` — pasarela de pago simulada (página de aprobar/rechazar y webhooks firmados con HMAC)
- `simulators/courier/` — courier simulado (cotización, guía PDF y estados con webhooks firmados). Ver `simulators/courier/README.md`

## Demo completa (un comando)
Catálogo de 50 productos, clientes, motorizados, zonas de Quito y 3 meses de pedidos para los reportes;
guion de 8 actos (compra, pago, despacho, tracking, entrega con OTP, factura, devolución con nota de
crédito y dashboard) en [docs/DEMO.md](docs/DEMO.md).
```bash
cp .env.demo.example .env
docker compose up -d --build     # tienda http://localhost · backoffice http://localhost/admin
```

## Arranque rápido (solo infraestructura)
```bash
cp .env.example .env        # y edita los valores
docker compose up postgres valkey seaweedfs mailpit ntfy
```
- Mailpit: http://localhost:8025
- PostgreSQL: localhost:5432 (usuario `app`, base `moda`)

## Tienda completa en Docker (perfil `front`)
```bash
cp .env.example .env                                   # PG_PASSWORD, JWT_SECRET, PAYSIM_SECRET...
docker compose up -d postgres valkey                   # 1) datos
cd backend && npm install && npm run migrate:up && npm run seed:dev   # imprime tenantId
# 2) pon ese tenantId en STORE_TENANT_ID de ./.env
cd .. && docker compose --profile front --profile backoffice --profile sims up -d --build
```
- Tienda: http://localhost (WAF → Caddy → storefront; `/api` → API, `/ws` → realtime)
- Backoffice: http://localhost/admin (usuarios del seed: `admin@demo.test`, `gerente@`, `vendedor@`, `bodega@`, `soporte@`, `logistica@demo.test`, contraseña `Demo-2026-segura`; el admin pide el código 2FA del secreto que imprime el seed)
- Pasarela simulada: http://localhost:8081 · Mailpit: http://localhost:8025
- Ver al motorizado moverse: compra con entrega por motorizado en Quito Norte, abre «Seguir mi pedido» y
  en `backend/` corre `API_URL=http://localhost/api/v1 npm run sim:rider -- <número de pedido>`.
- App del motorizado: `cd rider-app && EXPO_PUBLIC_API_URL=http://<IP del PC>/api npm run build:apk`, instala
  `dist/*.apk` y entra con `moto@demo.test` (ver `rider-app/README.md`, «Probar de punta a punta»).

## Demo: compra completa (v0.2)

Carrito → checkout → página de pago → aprobar/rechazar → webhook firmado → pedido pagado y stock descontado
(o pedido cancelado y stock liberado). La API corre en tu máquina y la pasarela simulada en Docker.

```bash
# 1) Infraestructura y simuladores (perfil sims). PAYSIM_SECRET y COURIERSIM_API_KEY de ./.env = los de backend/.env
cp .env.example .env
PAYSIM_WEBHOOK_URL=http://host.docker.internal:3000/v1/webhooks/payments/simulator \
COURIERSIM_WEBHOOK_URL=http://host.docker.internal:3000/v1/webhooks/couriers/simulator \
  docker compose --profile sims up -d postgres valkey pasarela-simulada courier-simulado

# 2) Backend (otra terminal)
cd backend
cp .env.example .env         # misma contraseña que PG_PASSWORD y mismo PAYSIM_SECRET
npm install
npm run migrate:up
npm run seed:dev             # imprime tenantId, userId, warehouseId, variantIds y las 3 zonas de Quito
npm run dev:api              # http://localhost:3000/v1
npm run dev:worker           # otra terminal: relay del outbox + pagos y reservas vencidos
```

```bash
# 3) Comprar como invitado (bash; en PowerShell usa $TOKEN = npm run -s token:dev -- ...)
T=<tenantId>; V=<variantIds[0]>; W=<warehouseId>
TOKEN=$(npm run -s token:dev -- $T <userId>)
curl -X POST localhost:3000/v1/inventory/stock/adjustments -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"variantId\":\"$V\",\"warehouseId\":\"$W\",\"type\":\"adjustment\",\"delta\":20,\"reason\":\"Inventario inicial\"}"

curl -c c.txt -b c.txt -H "X-Tenant-Id: $T" -H "Content-Type: application/json" \
  -X POST localhost:3000/v1/cart/items -d "{\"variantId\":\"$V\",\"quantity\":2}"

# Cotizar el envío (CCI, zona Quito Norte): motorizado con franjas. Copia options[0].quoteId y options[0].slots[0].slotId
ADDR='{"mainStreet":"Av. Amazonas y Naciones Unidas","city":"Quito","lat":-0.1765,"lng":-78.48}'
curl -b c.txt -H "X-Tenant-Id: $T" -H "Content-Type: application/json" \
  -X POST localhost:3000/v1/checkout/delivery-options -d "{\"shippingAddress\":$ADDR}"
Q=<quoteId>; S=<slotId>

curl -b c.txt -H "X-Tenant-Id: $T" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen || date +%s%N)" -X POST localhost:3000/v1/checkout \
  -d "{\"customer\":{\"name\":\"Ana Pérez\",\"email\":\"ana@demo.test\"},\"fulfillmentType\":\"rider\",
       \"shippingAddress\":$ADDR,\"deliveryQuoteId\":\"$Q\",\"deliverySlotId\":\"$S\",\"paymentMethod\":\"card\"}"
```

4) Abre en el navegador `payment.nextAction.url` (http://localhost:8081/pay?...) y pulsa **Aprobar pago** o
   **Rechazar pago**. La página muestra si el webhook se entregó y permite **reenviarlo** para ver la idempotencia
   (la API responde `duplicate`).

5) Verifica el resultado:

```bash
curl -H "Authorization: Bearer $TOKEN" localhost:3000/v1/orders/<orderId>          # paid (o cancelled)
curl -H "Authorization: Bearer $TOKEN" localhost:3000/v1/inventory/stock/$V/$W     # on_hand 18, reserved 0
curl -H "Authorization: Bearer $TOKEN" localhost:3000/v1/payments/<paymentId>      # captured + bitácora
```

Otros métodos: `"paymentMethod":"transfer"` (subir comprobante y aprobar en `/v1/payments/:id/transfer/...`) y
`"paymentMethod":"cod"` (contra entrega). Detalle en `backend/README.md`, secciones Checkout y Pagos.

## Demo: cotización de envío (v0.3)

Con lo anterior levantado, cotiza el mismo carrito a los puntos de ejemplo del seed:

| Dirección | `lat`, `lng`, `city` | Resultado |
|---|---|---|
| CCI (Quito Norte) | `-0.1765, -78.48, Quito` | motorizado, franjas de 3 h, gratis desde $60 |
| Plaza Grande (Centro Histórico) | `-0.2203, -78.5122, Quito` | motorizado con 2 cupos por franja; al llenarse → courier (`NO_SLOT_CAPACITY`) |
| Parque de Cumbayá | `-0.2025, -78.429, Cumbayá` | courier (`COURIER_ONLY_ZONE`), precio de la API (`source: api`) |
| Guayaquil | `-2.1894, -79.8891, Guayaquil` + `"province":"Guayas"` | courier (`NO_ZONE`) |

```bash
# Courier lento: a los 3 s la tienda corta y cotiza con courier_rate_cards (source: rate_card)
curl -X POST localhost:8082/admin/config -H 'content-type: application/json' -d '{"latencyMs":5000}'
curl -X POST localhost:8082/admin/config -H 'content-type: application/json' -d '{"latencyMs":0}'

# Zonas y franjas (token de staff con logistics.read / logistics.zone.write)
curl -H "Authorization: Bearer $TOKEN" "localhost:3000/v1/logistics/zones/resolve?lat=-0.1765&lng=-78.48"
curl -H "Authorization: Bearer $TOKEN" localhost:3000/v1/logistics/zones/<zoneId>/slots
```

Sin OSRM levantado, la distancia del motorizado sale en línea recta × 1,3 (`distanceSource: straight_line`). Con
`docker compose --profile maps up osrm` y `OSRM_URL=http://localhost:5000` en backend/.env, se usa la ruta real por
calle (`distanceSource: osrm`). El extracto de Ecuador se prepara una vez (docs/02-stack-open-source.md, sección 2.6).

Cuando la API y el worker corran dentro de Docker (falta el storefront y el backoffice para levantar Caddy), se omite
`PAYSIM_WEBHOOK_URL` y el simulador llama al valor por defecto, `http://api:3000`.
