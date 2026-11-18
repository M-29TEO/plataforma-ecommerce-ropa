# Backend (NestJS · monolito modular)

API, worker y (más adelante) realtime comparten este código; cambia solo el punto de entrada.

```text
apps/
  api/        # HTTP (/v1/...)
  worker/     # consumidores y schedulers de BullMQ
libs/
  shared-kernel/   # config, DB + transacción ambiental, outbox + relay, idempotencia, auth/RBAC, errores, dinero, colas
  modules/
    inventory/     # schema inventory
      api/             # controllers + DTOs (class-validator)
      application/     # casos de uso + puertos (repositorios abstractos) + InventoryApi (fachada)
      domain/          # reglas puras: reservas, ajustes, umbral, orden de compra, errores, eventos
      infrastructure/  # repositorios SQL (pg) y job de BullMQ
      index.ts         # API PÚBLICA del módulo
    orders/        # schema sales: orders, order_items, order_status_history, returns, return_items (misma estructura)
    catalog/       # schema catalog: por ahora solo la fachada de lectura (precio, IVA, snapshot)
    promotions/    # schema sales: promotions, coupons, promotion_redemptions, gift_cards(+transactions)
    cart/          # schema sales: carts, cart_items
    checkout/      # sin schema: orquesta Carrito, Inventario, Logística, Promociones, Pedidos, Pagos y Facturación en una transacción
    payments/      # schema payments: payments, payment_events, webhook_inbox, bank_transfers, refunds
    logistics/     # schema logistics: zonas, franjas, couriers, tarifario, cotizaciones, envíos pendientes y logística inversa
    billing/       # schema billing: factura y nota de crédito del SRI (secuencial, clave de acceso, XML, XAdES, RIDE, email)
    aftersales/    # sin schema: orquesta devoluciones y cambios (Pedidos, Logística, Inventario, Pagos, Promociones)
migrations/        # node-pg-migrate; 0001 = copia literal de docs/03-modelo-datos.sql
test/              # integración con Testcontainers (PostgreSQL + PostGIS, Valkey)
```

## Decisiones

| Tema | Decisión |
|---|---|
| Acceso a datos | SQL directo con `pg`. Los repositorios de `infrastructure/` implementan los puertos de `application/ports.ts`. |
| Migraciones | `node-pg-migrate`. Nunca se edita una migración ya aplicada: los cambios van en una nueva. |
| Ledger | `stock_movements` registra **solo cambios de `on_hand`**, así que `SUM(quantity) = on_hand`. Los compromisos (`reserved`) quedan en `stock_reservations`. |
| Reserva | UPDATE condicional atómico (patrón 1 de docs/03), todo o nada, con líneas **ordenadas por `(variant_id, warehouse_id)`** para evitar deadlocks. Es idempotente por pedido. |
| Vencimiento | Job BullMQ `release-expired-reservations` cada 60 s (`upsertJobScheduler`), con `FOR UPDATE SKIP LOCKED` para soportar varias réplicas. |
| `StockBelowThreshold` | Se escribe en `platform.outbox_events` en la misma transacción, solo cuando el disponible **cruza** el `reorder_point`. |
| Concurrencia optimista | `PATCH /stock/:variantId/:warehouseId` exige `version` y responde 409 `STALE_VERSION` si está desactualizada. |
| Recepción de más unidades | Se rechaza en el dominio (422 `OVER_RECEIPT`) y además con `CHECK (qty_received <= qty_ordered)` (migración `1759000000001`). |
| Autenticación | JWT HS256 con claims `sub`, `tid`, `typ`, `perms`. `@Auth('inventory.adjust')` exige todos los permisos indicados. Los tokens se obtienen con `POST /v1/auth/login` (ver Módulo IAM: los permisos salen de los roles del usuario; usuarios de prueba en `seed:dev`). `npm run token:dev` sigue sirviendo para tokens con permisos a medida. Toda ruta exige token salvo las marcadas con `@Public()` / `@OptionalAuth()`. |

### Permisos del módulo

`inventory.read`, `inventory.warehouse.write`, `inventory.stock.write`, `inventory.adjust`,
`inventory.supplier.write`, `inventory.purchase.write`, `inventory.purchase.receive`.

### Endpoints (`/v1/inventory/...`)

| Método y ruta | Permiso |
|---|---|
| `POST /warehouses` · `PATCH /warehouses/:id` · `DELETE /warehouses/:id` (lógico) | `inventory.warehouse.write` |
| `GET /warehouses` · `GET /warehouses/:id` · `GET /warehouses/nearby?lat&lng&radiusKm` | `inventory.read` |
| `GET /stock?warehouseId&variantId&belowReorderPoint` · `GET /stock/:variantId/:warehouseId` | `inventory.read` |
| `PATCH /stock/:variantId/:warehouseId` (reorden, reposición, ubicación; requiere `version`) | `inventory.stock.write` |
| `POST /stock/adjustments` (`adjustment` · `damage` · `count`) | `inventory.adjust` |
| `GET /stock/movements?variantId&warehouseId&beforeId&limit` · `GET /reservations?orderId` | `inventory.read` |
| `POST /suppliers` · `PATCH /suppliers/:id` | `inventory.supplier.write` |
| `POST /purchase-orders` · `POST /purchase-orders/:id/send` · `POST /purchase-orders/:id/cancel` | `inventory.purchase.write` |
| `POST /purchase-orders/:id/receipts` (parcial o total) | `inventory.purchase.receive` |

Las reservas **no** tienen endpoint público. Checkout y Pedidos las usan a través de `InventoryApi`
(`reserveStock`, `confirmReservation`, `releaseReservation`, `getAvailability`).

## Cómo probar

Requisitos: Node 24 y Docker Desktop en ejecución.

```bash
cd backend
npm install

# 1) Tests unitarios (sin Docker)
npm run test:unit

# 2) Tests de integración (levantan PostgreSQL+PostGIS y Valkey con Testcontainers)
npm run test:int

# Solo el test de concurrencia (10 reservas contra 3 unidades)
npx jest -c jest.int.config.js -t "10 reservas"
```

### A mano, con la infraestructura del docker-compose

```bash
# Desde la raíz del repositorio (necesita ./.env con PG_PASSWORD)
docker compose up -d postgres valkey

cd backend
cp .env.example .env          # usa en DATABASE_URL la misma contraseña que PG_PASSWORD
npm run migrate:up
npm run seed:dev              # imprime tenantId, userId, warehouseId y variantIds
npm run seed:demo             # seed:dev + 120 clientes, 6 motorizados, 2 zonas más y ~860 pedidos de 90 días (docs/DEMO.md)
npm run dev:api               # http://localhost:3000/v1
npm run dev:worker            # en otra terminal: job de reservas vencidas cada minuto

# Token de desarrollo (todos los permisos de Inventario)
TOKEN=$(npm run -s token:dev -- <tenantId> <userId>)

curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/v1/inventory/warehouses/nearby?lat=-0.1807&lng=-78.4678&radiusKm=10"

curl -X POST http://localhost:3000/v1/inventory/stock/adjustments \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"variantId":"<variantId>","warehouseId":"<warehouseId>","type":"adjustment","delta":20,"reason":"Inventario inicial"}'

curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/v1/inventory/stock/movements?variantId=<variantId>"
```

Con un token sin `inventory.adjust` (`npm run -s token:dev -- <tenantId> <userId> inventory.read`),
el ajuste responde **403**.

En PowerShell, en lugar de `TOKEN=$(...)`, usa `$TOKEN = npm run -s token:dev -- <tenantId> <userId>`.

## Módulo Pedidos (`libs/modules/orders`)

### Máquina de estados (`domain/order-status.ts`)

Tabla explícita: toda transición que no esté aquí responde **409 `INVALID_ORDER_TRANSITION`** y no escribe nada.

| Desde | Hacia | Condición |
|---|---|---|
| `created` | `paid` | no es contra entrega (COD) |
| `created` | `preparing` | **solo COD** (sin pago) |
| `paid` | `preparing` | — |
| `preparing` | `shipped` | no es retiro en tienda |
| `preparing` | `delivered` | **solo retiro en tienda** (`pickup`) |
| `shipped` → `in_transit` → `delivered` | | — |
| `created` · `paid` · `preparing` | `cancelled` | motivo obligatorio (422 `REASON_REQUIRED`) |
| `delivered` | `returned` | motivo obligatorio |

`cancelled` y `returned` son finales. `partially_returned` queda para el flujo de devoluciones.

### Decisiones

| Tema | Decisión |
|---|---|
| Transacción | Cada cambio de estado hace en **una** transacción: UPDATE del pedido, fila en `order_status_history` y eventos en el outbox. |
| Concurrencia optimista | `UPDATE ... WHERE version = $expected`; 409 `STALE_VERSION` si otro cambió el pedido. Los procesos del sistema (sin versión) bloquean la fila. |
| Snapshots | `order_items` guarda SKU, nombre, marca, categoría, color, talla, precio, IVA y costo del momento de la compra. |
| Montos | En centavos. IVA por línea sobre `cantidad × precio − descuento`, redondeo mitad hacia arriba. `total = subtotal − descuentos + IVA + envío − gift card`. Los descuentos de pedido se prorratean por línea en Checkout. |
| Eventos | `OrderPlaced` (creación), `OrderPaid` (→ paid; en COD, al entregar), `OrderCancelled` (con estado previo, estado de pago y líneas), `OrderDelivered`. |
| Contra entrega | `payment_status = cod_pending` hasta la entrega; al entregar pasa a `paid` y se emite `OrderPaid`, que es el único disparador de Facturación. |
| Inventario | Pedidos **no** llama a `InventoryApi`. Inventario reacciona por el relay del outbox a `OrderPlaced` (COD: confirmar reserva), `OrderPaid` (confirmar) y `OrderCancelled` (liberar; reponer lo ya consumido sigue pendiente). |
| Creación | Sin POST público: los precios los fija Checkout con `OrdersApi.placeOrder`, que es idempotente por `id` (el mismo `orderId` de la reserva de stock). |
| Pago | `OrdersApi.markPaid` (consumidor de `PaymentCaptured`) es idempotente aunque llegue el mismo evento dos veces a la vez. |

### Permisos y endpoints (`/v1/...`)

`orders.read`, `orders.status.update`, `orders.cancel`, `orders.payment.confirm` (migración `1759000000002`).

| Método y ruta | Quién |
|---|---|
| `GET /me/orders?status&limit&offset` · `GET /me/orders/:id` (con ítems e historial) | cliente (token `customer`); un pedido ajeno es 404 |
| `POST /me/orders/:id/cancel` `{version, reason}` | cliente, solo en `created` o `paid` |
| `GET /orders?status&paymentStatus&paymentMethod&fulfillmentType&channel&userId&from&to&q&limit&offset` | `orders.read` (`status` admite varios: `status=created,paid`; `q` = número o email) |
| `GET /orders/:id` · `GET /orders/:id/history` | `orders.read` |
| `POST /orders/:id/status` `{to, version, reason?}` | `paid` → `orders.payment.confirm`; `cancelled` → `orders.cancel`; resto → `orders.status.update` |

### Cómo probar Pedidos

```bash
npx jest -c jest.unit.config.js libs/modules/orders   # máquina de estados y agregado (sin Docker)
npx jest -c jest.int.config.js test/orders             # HTTP + PostgreSQL (Testcontainers)

npm run migrate:up && npm run seed:dev   # crea un cliente y 2 pedidos (card y cod); imprime sus ids
TOKEN=$(npm run -s token:dev -- <tenantId> <userId>)
CLIENTE=$(npm run -s token:dev -- <tenantId> <customerId> --customer)

curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/v1/orders?status=created&paymentMethod=cod"
curl -X POST http://localhost:3000/v1/orders/<orderIds.cod>/status \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"to":"preparing","version":0}'
curl -H "Authorization: Bearer $CLIENTE" http://localhost:3000/v1/me/orders
```

## Módulo Catálogo (`libs/modules/catalog`) — lectura, reseñas y preguntas

Carrito no puede leer `catalog.*` (regla: un módulo solo lee su schema), así que Catálogo expone
`CatalogApi.getSellableVariants(tenantId, variantIds)`: precio vigente (`variant.price ?? product.base_price`,
**sin IVA**), `tax_code`, si se puede vender (producto `active`, no borrado, variante `active`) y los datos
de snapshot que Pedidos guarda, y `getProductOffers(tenantId, productIds)` para la wishlist del CRM. La
administración del backoffice está en la sección siguiente; las reseñas y preguntas, más abajo (`CatalogReviewsModule`).

### Catálogo: administración (`application/catalog-admin.service.ts`)

Permiso `catalog.product.write` (admin, gerente, vendedor), tenant del JWT. Montos como string `"12.50"`
(se acepta también un número). `compareAtPrice` debe ser **mayor** que el precio de venta (422 `INVALID_PRICE`).
Al cambiar el `basePrice` (PATCH del producto o precios masivos) se revalidan, en la misma transacción y ya
aplicado todo, las variantes que **heredan** el precio (`price` null) con tachado: si alguna queda con
`compareAtPrice` ≤ su precio efectivo, 422 `INVALID_PRICE` con `details.variantIds` y ROLLBACK (corrígelas en
la misma petición de `admin/prices`).

| Endpoint (`/v1/catalog/...`) | Qué hace |
|---|---|
| `GET admin/products?q=&status=&categoryId=&brandId=&limit=&offset=` | Listado `{ items, total }` (q busca en nombre, slug, SKU y código de barras) |
| `GET admin/products/:id` | Producto completo + `variants` (con `effectivePrice`) + `media` |
| `POST admin/products` | Crea (201). Sin `slug` se genera del nombre sin tildes y único (`-2`, `-3`...). 409 `SLUG_TAKEN`, 422 `INVALID_REFERENCE` (categoría/marca/guía de otra tienda), 422 `UNKNOWN_TAX_CODE` |
| `PATCH admin/products/:id` | Campos opcionales + `expectedUpdatedAt` obligatorio: si el producto cambió, 409 `STALE_PRODUCT` (el modelo no tiene columna `version`; `updated_at` avanza ≥ 1 ms en cada cambio). `status: active` fija `publishedAt` la primera vez; archivar = `status: archived` |
| `POST admin/products/:id/variants` · `PATCH admin/variants/:id` | 409 `SKU_TAKEN` / `BARCODE_TAKEN` (únicos en toda la base) / `VARIANT_DUPLICATE` (mismo color + talla) |
| `PATCH admin/prices` | `{ products: [{ id, basePrice?, compareAtPrice? }], variants: [{ id, price?, compareAtPrice? }] }`, máx. 200 filas, **todo o nada**; `null` quita el precio tachado / vuelve al precio del producto. Responde `{ products, variants }` con los ids que cambiaron |
| `GET admin/lookups` · `POST admin/brands` · `admin/categories` (ruta calculada del padre) · `admin/colors` · `admin/sizes` | Tablas auxiliares; 409 `BRAND_TAKEN` / `CATEGORY_TAKEN` / `COLOR_TAKEN` / `SIZE_TAKEN` |
| `POST admin/products/:id/media` (multipart `file` + `colorId?`, `altText?`) · `DELETE admin/media/:id` | Foto jpg/png/webp ≤ 5 MB verificada por magic bytes, en el mismo almacén que las reseñas (clave `products/<tenant>/<producto>/<uuid>.<ext>`). Se sirve en `GET /v1/catalog/media/products/...` (pública): con `CATALOG_MEDIA_BASE_URL=/api/v1/catalog/media` las URL apuntan ahí. Quitar la foto borra la fila, no el archivo |
| `PATCH admin/media/:id` `{ colorId?: uuid\|null, altText?: string\|null (≤ 200), sortOrder?: int ≥ 0 }` | Edita una foto existente (auditado `catalog.media.updated`). Responde la foto `{ id, url, colorId, sortOrder, altText }`; 404 `MEDIA_NOT_FOUND`, 422 `INVALID_REFERENCE` (color de otra tienda) |
| `GET variants/lookup?barcode=` · `?ids=` · `?q=` | Bodega escanea / Vendedor arma pedidos: barcode exacto (0 o 1), `ids` (hasta 100 uuids separados por coma; solo las del tenant, las ajenas se omiten: así Inventario muestra nombre y SKU) o texto en SKU, código y nombre (máx. 20). Prioridad: barcode, ids, q; sin ninguno, 422 `LOOKUP_QUERY_REQUIRED`. Basta **cualquiera** de `inventory.read`, `catalog.product.write`, `orders.assisted.create`, `inventory.picking` |

Auditoría (`platform.audit_log`, en la misma transacción): `catalog.product.created|updated|price_changed`,
`catalog.variant.created|updated|price_changed` con `before`/`after`; altas auxiliares y fotos con `@Audited`.
Pruebas: `npx jest -c jest.unit.config.js libs/modules/catalog/domain/admin-catalog.spec.ts` y
`npx jest -c jest.int.config.js test/catalog/admin-catalog.int-spec.ts`.

## Módulo Promociones (`libs/modules/promotions`)

### Motor de reglas (`domain/engine.ts`, función pura)

| Tipo | `benefit` | Ejemplo |
|---|---|---|
| `percent` | `{ percent, maxDiscount? }` | 10 % con tope de $15 |
| `fixed` | `{ amount }` | $5 (nunca más que el valor de las líneas) |
| `buy_x_get_y` | `{ buyQuantity, getQuantity, percentOff = 100, maxApplications? }` | 2x1 = `{1, 1}`, 3x2 = `{2, 1}`, 2.ª al 50 % = `{1, 1, 50}`. Gratis las unidades **más baratas**. |
| `free_shipping` | `{ maxDiscount? }` + `conditions.minSubtotal` | Envío gratis desde $50 |
| `tiered` | `{ basis: 'subtotal' \| 'quantity', tiers: [{ min, percent \| amount }] }` | 5 % desde $50, 10 % desde $100 |

`conditions` (todas opcionales): `productIds`, `variantIds`, `categoryPaths` (incluye subcategorías),
`brandIds`, `excludeProductIds`, `excludeVariantIds`, `minSubtotal`, `minQuantity`. El dominio valida
cada campo según el tipo y rechaza los desconocidos (422 `INVALID_PROMOTION` con `details.field`).
`gift` existe en el modelo de datos pero no está implementado: se rechaza.

Reglas de evaluación:

1. **Vigencia:** `active`, `starts_at <= ahora < ends_at` y usos disponibles (promoción y cupón, global y por
   cliente; un cupón con `assigned_user_id` solo lo usa su dueño).
2. **Orden:** `priority` ascendente (menor = primero); a igual prioridad, automáticas antes que cupones y
   los cupones en el orden ingresado.
3. **Condiciones** (alcance, `minSubtotal`, `minQuantity`) sobre las líneas del alcance **antes de descuentos**:
   el resultado no depende del orden de las demás promociones.
4. **Combinación:** la primera aplicable siempre entra; las siguientes solo si ella y todas las ya aplicadas son
   `stackable`. Una no combinable aplicable deja fuera al resto (`NOT_COMBINABLE`); una que no cumple
   condiciones no bloquea a nadie.
5. **Descuento secuencial** sobre lo que queda de cada línea (nunca negativa), repartido por línea con el
   método del mayor residuo: la suma por línea es exactamente el descuento (necesario para el IVA).

Motivos de rechazo de un cupón: `COUPON_NOT_FOUND`, `PROMOTION_NOT_ACTIVE`, `PROMOTION_NOT_STARTED`,
`PROMOTION_EXPIRED`, `PROMOTION_USAGE_LIMIT`, `COUPON_USAGE_LIMIT`, `COUPON_CUSTOMER_LIMIT`,
`COUPON_NOT_ASSIGNED`, `CONDITIONS_NOT_MET` (con `missing`), `NOT_COMBINABLE`, `DUPLICATE_PROMOTION`.

### Decisiones

| Tema | Decisión |
|---|---|
| Evaluar vs. canjear | `evaluate()` solo **lee** (carrito, en cada vista). `redeem()` (checkout) **toma los cupos** en una transacción, todo o nada. |
| Límite global | `UPDATE ... SET used_count = used_count + 1 WHERE max_uses IS NULL OR used_count < max_uses` en cupón y promoción. N checkouts por el último cupo: solo uno ve la fila. |
| Límite por cliente | El UPDATE del cupón deja su fila bloqueada hasta el COMMIT; el conteo de canjes del cliente que viene después ya ve los canjes confirmados. |
| Clave de cliente | `user:<id>` o `email:<email>`; se cuentan ambas, así lo usado como invitado cuenta al registrarse con el mismo email. |
| Idempotencia | Por pedido: índice único `(order_id, promotion_id)` (migración `1759000000003`). Un reintento simultáneo devuelve el canje del primero. |
| Deadlocks | Orden fijo de bloqueo: cupones por id, luego promociones por id. |
| Revertir | `revertRedemptions(orderId)`: resta los contadores y borra los canjes. Idempotente. |
| Gift cards | Código Crockford base32 de 16 caracteres (80 bits), se muestra **una sola vez**; la base guarda SHA-256 y `last4`. Cada operación bloquea la fila (`FOR UPDATE`) y escribe saldo y movimiento juntos. Invariante: `SUM(gift_card_transactions.amount) = balance`. |
| Gift card: canje / reembolso | Canje idempotente por (tarjeta, pedido). `refundGiftCards(orderId, amount?)` devuelve a las tarjetas del pedido y nunca más de lo neto canjeado. |
| Gift card vencida | Estado efectivo `expired` al leer si pasó `expires_at` (el job que la pasa a `expired` con un movimiento `expire` queda pendiente). |

### Permisos y endpoints (`/v1/...`)

`promotions.read`, `promotions.write`, `giftcards.read`, `giftcards.write` (migración `1759000000003`).

| Método y ruta | Permiso |
|---|---|
| `POST /promotions` · `PATCH /promotions/:id` (`active=false` para desactivar) · `POST /promotions/:id/coupons` | `promotions.write` |
| `GET /promotions?active&type&limit&offset` · `GET /promotions/:id` (con cupones y usos) | `promotions.read` |
| `POST /gift-cards` (responde el código una vez) · `POST /gift-cards/:id/adjust` `{delta:"-5.00"}` · `/:id/block` · `/:id/activate` | `giftcards.write` |
| `GET /gift-cards?status` · `GET /gift-cards/:id` (con movimientos) | `giftcards.read` |
| `POST /gift-cards/balance` `{code}` | cliente o invitado (`X-Tenant-Id`) |

Checkout usa `PromotionsApi`: `evaluate`, `redeem`, `revertRedemptions`, `getGiftCardBalance`,
`redeemGiftCard`, `refundGiftCards`.

## Módulo Carrito (`libs/modules/cart`)

### Decisiones

| Tema | Decisión |
|---|---|
| Dueño | Cliente (Bearer de tipo `customer`; tenant del token) o invitado (cookie + header `X-Tenant-Id`, que en producción fija Caddy por dominio). Un token de staff recibe 403; un token inválido, 401 (no degrada a invitado). |
| Cookie del invitado | `cart_token`: 32 bytes aleatorios, `HttpOnly`, `SameSite=Lax`, `Secure` (salvo `SECURE_COOKIES=false`), `Max-Age` = `GUEST_CART_TTL_DAYS` (30). La base guarda solo su SHA-256 (índice único `ux_cart_guest_token`). Un carrito de invitado sin actividad por más de 30 días ya no se usa. Se crea con el primer ítem, no con un GET. |
| Fusión | En la primera petición autenticada que trae la cookie (o `POST /cart/merge`; IAM usará `CartApi.mergeGuestCart`). Suma cantidades (tope 20 por línea), conserva el `priceAtAdd` del usuario, une cupones (máx. 5), completa el contacto; el carrito del invitado queda `merged` y la cookie se borra. No valida stock (no se falla un login): la vista marca lo que exceda. |
| Concurrencia | Cada cambio corre en una transacción con la fila del carrito bloqueada (`FOR UPDATE`). La creación simultánea del carrito de un usuario la resuelve el índice único parcial `ux_cart_user_active`. |
| Stock | Al agregar o subir cantidad: total de la línea ≤ disponible (`InventoryApi.getAvailability`, bodegas activas que despachan online); si no, 409 `INSUFFICIENT_STOCK` con `available`. Bajar siempre se permite. Es una validación, **no** una reserva (la reserva la hace Checkout). |
| Avisos por línea | `UNAVAILABLE` y `OUT_OF_STOCK` (fuera de los totales), `INSUFFICIENT_STOCK` (en los totales, bloquea `canCheckout`), `PRICE_CHANGED` con `previousPrice`/`currentPrice`/`direction` (solo avisa; se cobra el precio vigente). `POST /cart/acknowledge-prices` acepta los precios nuevos. |
| IVA | Por línea según `tax_code` del producto (tabla del SRI en `shared-kernel/tax.ts`: 4 = 15 %, 0 = 0 %, 5 = 5 %...): `base = cantidad × precio − descuento`, IVA redondeado al centavo (mitad arriba), igual que Pedidos y la factura. Se devuelve el desglose por tarifa (`taxes`). |
| Totales | `subtotal − descuentos + IVA`. El envío se cotiza en Checkout; el carrito informa `freeShipping` si aplica una promoción de envío gratis. |
| Cupones | Solo se guarda un cupón que el motor acepta (si no, 422 con el motivo como código). Si luego deja de aplicar, queda visible con `applied=false` y su motivo. |

### Endpoints (`/v1/cart`, cliente o invitado)

| Método y ruta | Cuerpo |
|---|---|
| `GET /cart` | — (fusiona si llega token + cookie) |
| `POST /cart/items` · `PATCH /cart/items/:variantId` · `DELETE /cart/items/:variantId` | `{variantId, quantity}` · `{quantity}` · — |
| `POST /cart/coupons` · `DELETE /cart/coupons/:code` | `{code}` · — |
| `PUT /cart/contact` | `{email?, phone?}` (identifica al invitado para límites por cliente y recordatorios) |
| `POST /cart/acknowledge-prices` · `POST /cart/merge` (requiere token) | — |

Checkout usa `CartApi.lockCartForCheckout` (bloquea el carrito en su transacción), `CartApi.getPricedCart(tenantId, cartId, shippingTotal?)`, `CartApi.ownerRef` (identidad para idempotencia) y `CartApi.markConverted`.

### Cómo probar Carrito y Promociones

```bash
npx jest -c jest.unit.config.js libs/modules/promotions libs/modules/cart   # motor, gift cards, carrito, IVA
npx jest -c jest.int.config.js test/promotions test/cart                    # HTTP + PostgreSQL + concurrencia
npx jest -c jest.int.config.js -t "exactamente 3"                          # 10 checkouts por 3 cupos

npm run migrate:up && npm run seed:dev     # crea envío gratis desde $50, BIENVENIDA10 y 2X1CAMISETAS
TOKEN=$(npm run -s token:dev -- <tenantId> <userId>)
# Stock para vender (movimiento de ajuste, así el ledger cuadra)
curl -X POST http://localhost:3000/v1/inventory/stock/adjustments -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"variantId":"<variantIds[0]>","warehouseId":"<warehouseId>","type":"adjustment","delta":20,"reason":"Inventario inicial"}'

# Invitado: -c/-b guardan y envían la cookie httpOnly
curl -c cookies.txt -b cookies.txt -H "X-Tenant-Id: <tenantId>" -H "Content-Type: application/json" \
  -X POST http://localhost:3000/v1/cart/items -d '{"variantId":"<variantIds[0]>","quantity":4}'
curl -c cookies.txt -b cookies.txt -H "X-Tenant-Id: <tenantId>" -H "Content-Type: application/json" \
  -X POST http://localhost:3000/v1/cart/coupons -d '{"code":"2x1camisetas"}'

# Iniciar sesión como cliente con la misma cookie: fusiona y la borra
CLIENTE=$(npm run -s token:dev -- <tenantId> <customerId> --customer)
curl -c cookies.txt -b cookies.txt -H "Authorization: Bearer $CLIENTE" http://localhost:3000/v1/cart

# Gift card
curl -X POST http://localhost:3000/v1/gift-cards -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"amount":"25.00"}'
curl -X POST http://localhost:3000/v1/gift-cards/balance -H "X-Tenant-Id: <tenantId>" \
  -H "Content-Type: application/json" -d '{"code":"<code>"}'
```

En HTTP local, `backend/.env` debe tener `SECURE_COOKIES=false` (o `NODE_ENV=development`); si no, el
navegador no guarda la cookie `Secure`.

## Plataforma (shared kernel): una transacción para varios módulos, relay del outbox e idempotencia

| Pieza | Qué hace |
|---|---|
| Transacción ambiental (`Database`) | `withTransaction` guarda la conexión en `AsyncLocalStorage`. Si ya hay una transacción en curso, la anidada corre en un `SAVEPOINT` de esa misma transacción y `db.query` usa esa conexión. Así Checkout compone las fachadas de seis módulos en **una** transacción sin que esos módulos cambien ni se conozcan. Un error atrapado dentro de una anidada solo revierte su savepoint. Las anidadas se ejecutan una a la vez (no con `Promise.all`). |
| Relay del outbox (`OutboxRelay` + job `publish-outbox` cada 2 s en el worker) | Toma cada evento sin publicar (`FOR UPDATE SKIP LOCKED`, en orden de id), ejecuta los consumidores registrados en `EventBus` y marca `published_at` **en la misma transacción** que los efectos de los consumidores. Si un consumidor falla, se revierte todo, suma `attempts` y se reintenta; tras 10 intentos queda para revisión. Entrega "al menos una vez": todos los consumidores son idempotentes. |
| Idempotencia (`IdempotencyStore`) | `platform.idempotency_keys` por `(scope, user_ref, key)`. La clave se inserta en la misma transacción que la operación: una petición simultánea con la misma clave espera en el índice único y recibe la respuesta guardada; la misma clave con otro cuerpo → 422 `IDEMPOTENCY_KEY_REUSED`. Los errores no se guardan (se revierten). |

### Consumidores de eventos (proceso worker)

| Evento | Consumidor | Efecto |
|---|---|---|
| `PaymentCaptured` | Pedidos | `markPaid` (no hace nada si ya está pagado; si el pedido ya se canceló, lo registra para reembolso) |
| `PaymentFailed` · `PaymentExpired` | Pedidos | cancela el pedido **solo si sigue en `created`** |
| `OrderPlaced` (COD) · `OrderPaid` | Inventario | confirma la reserva (movimiento `sale`); sin reserva activa, no hace nada |
| `OrderCancelled` | Inventario | libera la reserva activa |
| `OrderCancelled` | Promociones | devuelve cupos de cupones/promociones y saldo de gift cards |
| `OrderCancelled` | Pagos | cancela los pagos abiertos del pedido |
| `OrderDelivered` (COD) | Pagos | captura el pago contra entrega |
| `OrderPaid` (en COD, emitido al entregar) | Facturación | crea la factura (secuencial + clave de acceso); el job la firma, la envía al SRI y la envía por email |
| `RefundSucceeded` | Pedidos | la devolución queda `refunded`; el pedido, `partially_refunded` o `refunded` |
| `RefundSucceeded` (de una devolución) | Facturación | crea la nota de crédito (04) vinculada a la factura; el job espera a que la factura esté autorizada |

## Módulo Checkout (`libs/modules/checkout`) — orquestador sin schema

**Antes de pagar**, `POST /v1/checkout/delivery-options {shippingAddress: {mainStreet, city, province?, lat, lng}}`
(mismo cliente o invitado) cotiza el envío del carrito con Logística, **fuera de toda transacción** (OSRM y couriers
pueden tardar hasta 3 s). Devuelve `fulfillmentType` (`rider` o `courier`), el motivo y las opciones, cada una con su
`quoteId` firmado. Las de motorizado traen además sus franjas (`slots[].slotId` y el precio con recargo).

`POST /v1/checkout` (cliente con Bearer `customer`, o invitado con la cookie del carrito + `X-Tenant-Id`),
con header **`Idempotency-Key`** obligatorio. Salvo retiro en tienda, exige `shippingAddress` con `lat`/`lng`,
`deliveryQuoteId` y, con motorizado, `deliverySlotId`. En **una sola transacción**:

1. Bloquea el carrito (`FOR UPDATE`) y **recalcula** precios, stock, promociones e IVA (`CartApi.getPricedCart`).
   Si hay líneas agotadas o sin stock → 409 `CART_NOT_READY`.
2. Valida la opción de envío (`LogisticsApi.resolveDelivery`, sin llamadas externas). Debe ser la misma dirección, el
   mismo paquete y el mismo total cotizados; si no → 409 `DELIVERY_QUOTE_MISMATCH`. Si venció → 409
   `DELIVERY_QUOTE_EXPIRED`; si fue alterada → 422. Vuelve a precificar el carrito con ese envío (envío gratis por
   promoción). Si llega `expectedTotal` y no coincide → 409 `CHECKOUT_TOTAL_CHANGED`.
3. Elige bodegas (`InventoryApi.planAllocation`: una sola si alcanza; en retiro, la tienda elegida) y **reserva el stock**
   (UPDATE condicional atómico). La reserva dura 10 min más que el pago (tope 24 h).
4. Toma los cupos de promociones y descuenta la gift card.
5. Crea el pedido (`OrdersApi.placeOrder`, con `shipping_zone_id` y `delivery_slot_id`) y verifica que su total sea el calculado.
6. **Reserva el cupo de la franja** y crea el envío `pending` (`LogisticsApi.bookDelivery`). Si otro cliente tomó
   el último cupo → 409 `SLOT_UNAVAILABLE`. En contra entrega, `cod_amount` es el total del pedido.
7. Crea el pago con clave de idempotencia (`PaymentsApi.createPayment`).
8. Marca el carrito como convertido.

Si cualquier paso falla (stock, cupo de la franja, último cupo del cupón, gift card bloqueada...), no queda nada escrito.

| Tema | Decisión |
|---|---|
| Envío | Lo cotiza Logística (IVA incluido): motorizado por zona, distancia y peso, o courier por API o tarifario. Retiro en tienda: $0. Las promociones de envío gratis descuentan sobre lo cotizado. |
| Gift card | Cubre hasta su saldo. Si cubre todo, el pago es `gift_card` y se captura en el acto. |
| Doble clic | Misma `Idempotency-Key` → misma respuesta (mismo pedido y pago) con `Idempotent-Replayed: true`. El `user_ref` es `user:<id>` o `guest:<sha256 de la cookie>`, así que no depende del carrito (que ya quedó convertido). |

Respuesta `201`:

```json
{
  "orderId": "…", "orderNumber": "1001", "status": "created", "paymentStatus": "pending",
  "totals": { "subtotal": "40.00", "discountTotal": "0.00", "taxTotal": "6.00", "shippingTotal": "3.00", "giftCardTotal": "0.00", "total": "49.00" },
  "delivery": { "fulfillmentType": "rider", "shipmentId": "…", "zoneId": "…", "deliverySlotId": "…" },
  "payment": {
    "payment": { "id": "…", "method": "card", "status": "pending", "amount": "49.00", "expiresAt": "…" },
    "clientSecret": "…",
    "nextAction": { "type": "redirect", "url": "http://localhost:8081/pay?ref=ps_…&amount=49.00&…&sig=…" }
  }
}
```

`nextAction.type`: `redirect` (tarjeta, DeUna, Pichincha, QR), `bank_transfer` (cuenta y referencia), `cash_on_delivery` o `none`.

### Pedidos asistidos (backoffice, `application/assisted-order.service.ts`)

El vendedor arma el pedido a nombre de un cliente (teléfono, WhatsApp, tienda). Permiso `orders.assisted.create`
(roles vendedor y admin). Reutiliza el checkout (`CheckoutService.placePriced`: envío firmado, reserva, promociones,
pedido y pago en una transacción); solo cambia la fuente de precios: un borrador en memoria (`CartApi.priceDraft`,
mismas reglas que el carrito, sin guardar nada). El pedido queda con `channel = 'backoffice'`, `seller_id` = vendedor y
`cart_id` null; el cliente recibe las notificaciones normales (OrderPlaced).

| Método | Ruta | Uso |
|---|---|---|
| GET | `/v1/assisted-orders/customers?q=` | clientes por email, nombre, teléfono o cédula/RUC (máx. 20) con sus direcciones |
| POST | `/v1/assisted-orders/quote` | totales y opciones de envío/franjas con `quoteId` firmado (no reserva) |
| POST | `/v1/assisted-orders` | crea el pedido (header `Idempotency-Key`); pago `transfer`, `cod` o `card_link` |
| GET | `/v1/assisted-orders?mine=true\|false&limit=&offset=` | pedidos del canal backoffice (por defecto solo los míos) |
| POST | `/v1/assisted-orders/:orderId/transfer-voucher` | el vendedor sube el comprobante que el cliente le mandó (multipart `file`) |

`card_link` crea un pago con tarjeta y devuelve `payment.paymentUrl` (pasarela simulada) para enviárselo al cliente;
`transfer` devuelve la cuenta, la referencia y `voucherUploadPath` + `clientSecret` (header `X-Payment-Secret`).

**Plazos.** El cliente paga más tarde, desde WhatsApp, así que los pagos asistidos no usan los plazos del checkout web
(que no cambian):

| Método | Vence | Reserva de stock |
|---|---|---|
| `card_link` | `ASSISTED_PAYMENT_LINK_TTL_MINUTES` (por defecto 1440 = 24 h; entre 15 y 4320) | plazo del pago + 10 min |
| `transfer` | el mayor entre ese plazo y `PAYMENT_TRANSFER_TTL_HOURS` (12 h) → 24 h por defecto | plazo del pago + 10 min |
| `cod` | no vence | 1 h (se confirma al crear el pedido) |

El plazo viaja como `ttlSeconds` en `PaymentsApi.createPayment` y lo usa también la firma `exp` de la URL de la pasarela.
La reserva se calcula igual que en el checkout web (`reservationTtlSeconds`: pago + 10 min). Por eso se subió el
tope: `RESERVATION_MAX_SECONDS` = 72 h + 10 min (antes 24 h, que con un enlace de 24 h dejaba la reserva sin margen) y
el tope genérico de Inventario a 7 días; los plazos de pago se validan a ≤ 72 h (`PAYMENT_TTL_MAX_MINUTES`, también
`PAYMENT_ONLINE_TTL_MINUTES` y `PAYMENT_TRANSFER_TTL_HOURS`). Los jobs no cambian: `expire-pending-payments` vence el
pago en su `expires_at` (PaymentExpired → Pedidos cancela → Inventario libera) y `release-expired-reservations`
libera la reserva solo después, si quedó huérfana. El plazo de la transferencia incluye la verificación del
backoffice: un comprobante subido que nadie revisa antes de `expires_at` también vence.

**Comprobante subido por el vendedor.** `POST /v1/assisted-orders/:orderId/transfer-voucher`, permiso
`orders.assisted.create`, multipart: `file` (JPG, PNG o PDF, máx. 5 MB, tipo verificado por magic bytes), `bankName`
y `reference` opcionales (sin banco queda "No indicado (subido por el vendedor)"). Sin `clientSecret`: usa
`PaymentsApi.submitTransferVoucherAsStaff`, con las mismas validaciones que `POST /v1/payments/:id/transfer/voucher`.
Responde `200` con el pago (`status: 'pending'`): queda por verificar por alguien con `payments.transfer.verify`. Se
audita (`orders.assisted.transfer_voucher`, actor staff, sin guardar el archivo) y la bitácora del pago registra
`voucher_submitted` con `submittedBy: 'staff:<id>'`. Errores: pedido inexistente o de otro canal (web/app) → 404
`ORDER_NOT_FOUND`; pedido que no es por transferencia → 409 `NOT_A_TRANSFER`; comprobante ya en revisión → 409
`VOUCHER_ALREADY_SUBMITTED`; archivo ausente, de otro tipo o de más de 5 MB → 422 `VOUCHER_*`.

**Vuelta a la tienda.** La pasarela simulada vuelve a `/checkout/resultado?paymentId=...` sin parámetros firmados.
Quien paga desde el enlace asistido no tiene el secreto del pago en su navegador: la página muestra "Estamos
confirmando tu pago…" con acceso a Mis pedidos; la confirmación llega por el webhook y el correo.

Pruebas: `npx jest -c jest.int.config.js test/checkout/assisted-orders.int-spec.ts`.

## Módulo Pagos (`libs/modules/payments`)

Schema `payments`: `payments`, `payment_events` (bitácora), `webhook_inbox`, `bank_transfers`.

### Máquina de estados (`domain/payment.ts`)

```text
requires_action ──comprobante──▶ pending ──captura──▶ captured   (PaymentCaptured)
       │                           │  └──rechazo──▶ failed       (PaymentFailed)
       └────────────┬──────────────┴──vence──▶ expired           (PaymentExpired)
                    └──pedido cancelado──▶ cancelled
```

Repetir una operación ya aplicada no hace nada (webhooks y eventos llegan más de una vez); cualquier otra sobre un
estado final → 409 `INVALID_PAYMENT_TRANSITION`. Un pago vencido no se captura aunque el job aún no lo haya marcado.

| Método | Proveedor | Estado inicial | Vence | Se captura con |
|---|---|---|---|---|
| `card` · `deuna` · `pichincha` · `qr` | `simulator` (`PaymentGatewayPort`) | `pending` | 15 min (`PAYMENT_ONLINE_TTL_MINUTES`) | webhook firmado de la pasarela |
| `transfer` | `manual` | `requires_action` | 12 h (`PAYMENT_TRANSFER_TTL_HOURS`) | aprobación en backoffice |
| `cod` | `manual` | `pending` | nunca | `OrderDelivered` |
| `gift_card` | `internal` | capturado | — | en el checkout |

### Pasarela: `PaymentGatewayPort` → `SimulatorGateway`

- `createIntent` no hace I/O (se llama dentro de la transacción del checkout): arma la URL de la página de pago del
  simulador con el cobro firmado (HMAC-SHA256 de los parámetros ordenados). La referencia `ps_<id del pago>` es determinista.
- Webhook: `POST /v1/webhooks/payments/simulator` con `X-Paysim-Signature: t=<unix>,v1=<hex>`,
  `v1 = HMAC-SHA256(PAYSIM_SECRET, "<t>.<cuerpo crudo>")`, tolerancia 5 min (anti replay). Se firma el **cuerpo crudo**
  (`rawBody: true` en Nest) y se compara en tiempo constante.
- Agregar Datafast o Payphone = otra clase que implemente el puerto.

### Webhook: inbox idempotente → firma → captura → evento (una transacción)

| Caso | Respuesta | Qué queda |
|---|---|---|
| Nuevo y firma válida | 200 `processed` | fila en `webhook_inbox` (procesada), pago `captured`/`failed`, bitácora, `PaymentCaptured`/`PaymentFailed` en el outbox |
| Mismo `external_id` otra vez (o simultáneo) | 200 `duplicate` | nada nuevo (`UNIQUE (provider, external_id)`) |
| Firma inválida, ausente o vieja | 401 | fila con `signature_valid=false`, error `INVALID_SIGNATURE`; el pago no cambia |
| Firma válida para un id que antes llegó con firma falsa | 200 `processed` | la fila se reemplaza: un atacante no puede "reservar" ids de eventos reales |
| Monto distinto, pago inexistente, ya capturado, vencido o cancelado | 200 `ignored` + motivo | `webhook_inbox.error` y bitácora (`late_approval` → reembolso manual) |
| Error inesperado | 5xx | se revierte todo, también el inbox: la pasarela reintenta |

### Transferencia con comprobante

1. Checkout devuelve la cuenta, la referencia (`PAGO-XXXXXXXX`) y el `clientSecret`.
2. `POST /v1/payments/:id/transfer/voucher` (multipart: `voucher` jpg/png/pdf ≤ 5 MB, `bankName`, `reference`) con
   header `X-Payment-Secret`. El archivo va a SeaweedFS (filer HTTP) o a memoria (`VOUCHER_STORAGE=memory`). → `pending`.
3. Backoffice: `GET /v1/payments?method=transfer&status=pending`, `GET /v1/payments/:id/transfer/voucher`,
   `POST /v1/payments/:id/transfer/approve` o `/reject {reason}`.

### Vencimiento

Job `expire-pending-payments` cada 60 s en el worker (`SKIP LOCKED`): pagos `pending`/`requires_action` con
`expires_at` vencido → `expired` + `PaymentExpired` → Pedidos cancela → Inventario libera la reserva.

### Permisos y endpoints (`/v1/...`)

`payments.read`, `payments.transfer.verify` (migración `1759000000004`).

| Método y ruta | Quién |
|---|---|
| `POST /checkout` | cliente o invitado, header `Idempotency-Key` |
| `GET /payments/:id/public` | quien tenga el `clientSecret` (header `X-Payment-Secret`; invitado con `X-Tenant-Id`) |
| `POST /payments/:id/transfer/voucher` | ídem |
| `GET /payments?status&method&orderId` · `GET /payments/:id` (con bitácora y transferencia) · `GET /payments/:id/transfer/voucher` | `payments.read` |
| `POST /payments/:id/transfer/approve` · `POST /payments/:id/transfer/reject` | `payments.transfer.verify` |
| `POST /webhooks/payments/simulator` | pasarela (firma HMAC) |

### Cómo probar Checkout y Pagos

```bash
npx jest -c jest.unit.config.js libs/modules/payments libs/modules/checkout libs/modules/inventory/domain/allocation.spec.ts
npx jest -c jest.int.config.js test/checkout test/payments test/platform

# Solo los casos pedidos
npx jest -c jest.int.config.js -t "doble clic"
npx jest -c jest.int.config.js -t "webhook duplicado"
npx jest -c jest.int.config.js -t "firma inválida"
npx jest -c jest.int.config.js -t "pago rechazado"

# Simulador (Node, sin Docker)
cd ../simulators/payments && node --test
```

Demo de punta a punta: ver "Demo: compra completa" en el README de la raíz.

## Módulo Logística (`libs/modules/logistics`) — cotización, calificaciones y liquidaciones

Schema `logistics`: `coverage_zones`, `delivery_slot_templates`, `delivery_slots`, `couriers`, `courier_services`,
`courier_rate_cards`, `courier_quotes`, `shipments` (por ahora solo en estado `pending`), `ratings`, `riders` (comisión, efectivo y
rating), `rider_settlements` y `rider_settlement_items`. Tracking, despacho automático, turnos y prueba de entrega: ver "Tracking del motorizado" y "App del motorizado" más abajo.

```text
DeliveryQuoteService ─▶ ZoneResolver: ST_Covers(area, punto), la zona de menor priority gana
        │             ─▶ DeliveryRulesEngine: zona rider/both + peso ≤ max_weight_kg + franja con cupo → motorizado
        │                                     si no → courier (motivo: NO_ZONE, COURIER_ONLY_ZONE, OVERWEIGHT, NO_SLOT_CAPACITY)
        ├─ motorizado ─▶ RiderPricing: base + km × fee_per_km + kg extra (sobre 2 kg) × fee_per_extra_kg + recargo de franja
        │                 km: MapsPort → OSRM; si OSRM no responde (o OSRM_URL vacío), línea recta × 1,3
        │               ─▶ SlotService: franjas con cupo (booked < capacity) y sin cerrar
        └─ courier ────▶ CourierQuoteAggregator: todos los couriers en paralelo, 3 s cada uno (COURIER_QUOTE_TIMEOUT_MS);
                          el que falla o no responde se cotiza con courier_rate_cards; todo queda en courier_quotes
```

| Tema | Decisión |
|---|---|
| Área | GeoJSON `Polygon`, `MultiPolygon` o `Feature` (`[lng, lat]`). Se valida la estructura (anillos cerrados, rangos) y la topología con `ST_IsValid` (un "moño" → 422 `INVALID_AREA`). Se guarda como `geography(MultiPolygon)`. |
| Zona con motorizado | Exige `serving_warehouse_id`: la bodega es el origen de la distancia. Borrado lógico (`active = false`). |
| Peso | El mayor entre el peso real y el volumétrico (cm³/5000, con las dimensiones de la variante), hacia arriba a 0,1 kg. Para el máximo de la zona cuenta el peso real. |
| Envío gratis de la zona | Si la mercadería (IVA incluido, con descuentos) alcanza `free_shipping_threshold`, la tarifa del motorizado es $0. El recargo de una franja premium se cobra igual. |
| Franjas | Las plantillas van en hora local; America/Guayaquil es UTC−5 fijo. Se generan `DELIVERY_SLOT_DAYS_AHEAD` días (7) con `ON CONFLICT (zone_id, starts_at) DO NOTHING`: el job horario del worker, al crear o cambiar una plantilla y con `POST .../slots/generate`. Cierre = inicio − `DELIVERY_SLOT_LEAD_MINUTES` (120) o `same_day_cutoff` para las del mismo día. Cambiar una plantilla no toca franjas ya generadas; su cupo se ajusta con `PATCH .../slots/:id`. |
| Cupo | `UPDATE ... SET booked = booked + 1 WHERE booked < capacity AND cutoff_at > now()`, igual que la reserva de stock. Dos clientes por el último cupo: uno entra y el otro recibe 409 `SLOT_UNAVAILABLE`. |
| Liberación | Al reservar se crea un `shipments` en `pending` con su franja. `OrderCancelled` pasa a `cancelled` **solo** los envíos `pending` y devuelve el cupo: un evento repetido no descuenta dos veces. |
| Cotización firmada | Cada opción viaja como `quoteId` firmado con HMAC (vence en `DELIVERY_QUOTE_TTL_MINUTES`, 15). Incluye precio, zona, bodega, distancia, destino, peso y total. Al pagar no se vuelve a llamar a OSRM ni a los couriers: si el destino, el carrito o el total cambiaron → 409 `DELIVERY_QUOTE_MISMATCH`. `courier_quotes` exige `courier_service_id`, así que no sirve para el motorizado. |
| Courier | `CourierPort` (`quote`, `createShipment`, `getLabel`) → `CourierSimuladoAdapter` (`COURIER_ADAPTERS=simulator`, `COURIERSIM_URL`, `COURIERSIM_API_KEY`). Si la API respondió pero sin un servicio, ese servicio no cubre el destino. La provincia de destino se toma de la dirección o, si falta, de una tabla de ciudades. Tarifario: la tarifa de la ciudad gana a la de la provincia, y esta a `dest_province = '*'` (resto del país). |

Migración `1759000000005`: permisos `logistics.read` y `logistics.zone.write`, más `CHECK (end_time > start_time)` y
`CHECK (capacity >= 0)` en `delivery_slot_templates`. No cambia columnas.

### Endpoints (`/v1/logistics/...`)

| Método y ruta | Permiso |
|---|---|
| `POST /zones` · `PATCH /zones/:id` · `DELETE /zones/:id` (lógico) | `logistics.zone.write` |
| `GET /zones?active&city` · `GET /zones/:id` · `GET /zones/resolve?lat&lng` | `logistics.read` |
| `GET·POST /zones/:id/slot-templates` · `PATCH·DELETE /zones/:id/slot-templates/:tid` | lectura: `logistics.read`; escritura: `logistics.zone.write` |
| `GET /zones/:id/slots?from&to` · `POST /zones/:id/slots/generate` · `PATCH /zones/:id/slots/:slotId {capacity}` | ídem |
| `POST /quotes {destination:{lat,lng,city,province?}, weightG, volumeCm3?, merchandiseTotal?}` (sin carrito, para backoffice y demo) | `logistics.read` |

### Seed: 3 zonas reales de Quito (`scripts/seed-logistics.ts`)

Los polígonos están trazados a mano sobre las avenidas principales en OSM. Son aproximados, **no** límites oficiales.

| Zona | Modo | Tarifa | Franjas | Punto de ejemplo |
|---|---|---|---|---|
| Quito Norte · La Carolina, Iñaquito y Bicentenario (incluye la bodega UIO-01) | `rider`, prioridad 10 | $2.50 + $0.35/km + $0.50/kg extra, gratis desde $60, corte 14:00 | L-S 9-12, 12-15, 15-18 (8 cupos) y 18-20 (+$1); D 10-13 (+$1.50) | CCI (-0.1765, -78.4800) |
| Centro Histórico | `rider`, prioridad 20, máx. 10 kg | $2.00 + $0.30/km, corte 12:00 | L-V 10-13 y 14-17 (**2 cupos**: se llena rápido → courier) | Plaza Grande (-0.2203, -78.5122) |
| Valle de Cumbayá y Tumbaco | `courier` | — | — | Parque de Cumbayá (-0.2025, -78.4290) |

Courier `simulador` con los servicios `ESTANDAR` (48 h) y `EXPRESS` (24 h), y tarifario desde Quito hacia Quito,
Pichincha, Guayas, Azuay y `*`, igual al del simulador sin su recargo del 4 %.

### Calificaciones mutuas cliente ↔ motorizado (`application/rating.service.ts`)

| Tema | Decisión |
|---|---|
| Quién califica | El cliente califica al motorizado (`POST /v1/me/shipments/:id/rating`) y el motorizado al cliente (`POST /v1/rider/shipments/:id/rating`). Una por envío y por lado (`UNIQUE (shipment_id, rater_type)`): la segunda da 409 `ALREADY_RATED`. `rater_id` y `ratee_id` son siempre `iam.users.id`. |
| Cuándo | Solo envíos con motorizado en `delivered` y hasta 7 días después de `delivered_at` (si no, 409 `SHIPMENT_NOT_RATEABLE`). Un envío ajeno da 404. El dueño del pedido se consulta con `OrdersApi`, sin join a `sales`. Un pedido de invitado no se puede calificar: 422 `CUSTOMER_NOT_RATEABLE`. |
| Puntaje | Entero de 1 a 5, hasta 5 etiquetas de un catálogo según quién califica (`domain/rating.ts`) y un comentario de hasta 500 caracteres. |
| `rating_avg` | Se recalcula completo desde `ratings` (`round(avg, 2)`, sin arrastrar redondeos), con la fila del motorizado bloqueada **antes** de insertar: 10 calificaciones en paralelo no pierden ninguna. Sin calificaciones vuelve al 5 por defecto del modelo. El cliente no tiene columna agregada: su promedio viaja en el evento `CustomerRated` (para CRM y `cod_blocked`). |
| Eventos | `RiderRated` y `CustomerRated` por el outbox. |

### Liquidaciones semanales (`application/settlement.service.ts`, `domain/settlement.ts`)

```text
Job lunes 03:00 America/Guayaquil (RIDER_SETTLEMENT_CRON, cola "logistics-settlements")
  └─ por motorizado, en su propia transacción y con su fila bloqueada (FOR UPDATE):
       entregas 'delivered' con motorizado, antes del lunes 00:00, que no están en ninguna liquidación
       (incluye las de semanas anteriores que quedaron sin liquidar)
       ─▶ comisión por entrega = per_delivery + km (hacia arriba a 0,1 km) × per_km   (commission_scheme)
       ─▶ bono = el mayor bonus_tiers alcanzado por cantidad de entregas
       ─▶ cod_collected = solo efectivo (card_pos y deuna_qr no pasan por el motorizado)
       ─▶ rider_settlements 'draft' + rider_settlement_items; si cod_balance > cod_limit → RiderCodLimitExceeded

draft ──approve {codRemitted}──▶ approved ──mark-paid──▶ paid
  └──dispute {reason}──▶ disputed ──approve──▶ approved
```

| Tema | Decisión |
|---|---|
| `commission_scheme` | `{"per_delivery":2.50,"per_km":0.30,"bonus_tiers":[{"min_deliveries":40,"amount":10}]}`. Los montos pueden ser número o string con 2 decimales. Si es inválido, ese motorizado queda en `failed` (`INVALID_COMMISSION_SCHEME`) y el resto se liquida igual. |
| Idempotencia | Volver a correr el job (reintento, dos réplicas, botón del backoffice) recalcula el **borrador** del período: suelta sus ítems y los vuelve a armar, así entran las entregas tardías. Nunca toca una liquidación `approved` ni `paid`. Una `disputed` solo se recalcula con `rebuildDisputed: true`. El bloqueo por motorizado más `UNIQUE (rider_id, period_start, period_end)` evitan duplicados, y `shipment_id` es UNIQUE en los ítems: una entrega no se paga dos veces. |
| Efectivo contra entrega | `cod_balance` es el efectivo que el motorizado tiene en mano. Lo **suma** la entrega en efectivo (flujo de despacho, siguiente paso) y lo **baja** la aprobación. Al aprobar, el backoffice registra `codRemitted`, el efectivo que entregó. Lo que falte se retiene de su pago (`deductions`, como máximo lo que gana), y lo que la retención no cubra queda en `cod_balance` para la semana siguiente. `codRemitted` mayor que el saldo da 422 `COD_REMITTED_EXCEEDS_BALANCE`. El detalle muestra `cod: {codBalance, codLimit, codAvailable, overLimit}`. |
| Borrador | `deductions` y `net_payable` del borrador son una **propuesta** (retener todo el saldo, con `cod_remitted = 0`). Se recalculan al aprobar. |
| Segregación | `logistics.settlement.manage` genera y disputa; `logistics.settlement.approve` aprueba y marca pagada. El motorizado ve y disputa solo lo suyo (`/v1/rider/settlements`). |
| Eventos | `RiderSettlementDrafted`, `RiderSettlementApproved` (con `codBalanceBefore`/`codBalanceAfter`), `RiderSettlementDisputed` (con el motivo), `RiderSettlementPaid` y `RiderCodLimitExceeded`. |

Migración `1759000000006`: permisos `logistics.settlement.manage` y `logistics.settlement.approve`; índices
`ix_ratings_ratee (ratee_id, rater_type)` (recalcular el promedio) e `ix_ship_rider_delivered` (entregas sin liquidar);
`CHECK` de `cod_balance >= 0`, período ordenado y montos no negativos en `rider_settlements`. No cambia tablas ni columnas.

| Método y ruta (`/v1`) | Quién |
|---|---|
| `POST /me/shipments/:id/rating {score, tags?, comment?}` | cliente |
| `POST /rider/shipments/:id/rating` · `GET /rider/settlements` · `GET /rider/settlements/:id` · `POST /rider/settlements/:id/dispute {reason}` | motorizado (token `rider`) |
| `GET /logistics/riders/:id/ratings?limit` · `GET /logistics/settlements?riderId&status&periodStart` · `GET /logistics/settlements/:id` | `logistics.read` |
| `POST /logistics/settlements/generate {periodStart?, rebuildDisputed?}` · `POST /logistics/settlements/:id/dispute {reason}` | `logistics.settlement.manage` |
| `POST /logistics/settlements/:id/approve {codRemitted}` · `POST /logistics/settlements/:id/mark-paid` | `logistics.settlement.approve` |

`seed:dev` crea el motorizado de demo `moto@demo.test` (imprime `riderId` y `riderUserId`). Token de motorizado:
`npm run -s token:dev -- <tenantId> <riderUserId> --rider`.

### Cómo probar Logística

```bash
npx jest -c jest.unit.config.js libs/modules/logistics
npx jest -c jest.int.config.js test/logistics/ratings-settlements.int-spec.ts   # calificaciones y liquidaciones
npx jest -c jest.int.config.js test/logistics      # PostGIS real; OSRM y courier falsos (ok, caído y lento: timeout de 3 s)
npx jest -c jest.int.config.js test/checkout/delivery.int-spec.ts   # checkout: franjas, último cupo, courier, cancelación
cd ../simulators/courier && node --test
```

## Fulfillment: picking de bodega (`libs/modules/fulfillment`) — orquestador sin schema

Compone Pedidos, Catálogo y Logística por sus fachadas (Logística importa Pedidos, por eso el flujo vive
aquí; nadie importa este módulo). Permiso `inventory.picking` (rol Bodega y admin); solo usuarios staff.

| Método y ruta (`/v1`) | Qué hace |
|---|---|
| `GET /fulfillment/picking?warehouseId=&state=to_pick\|picking&limit=&offset=` | Cola de la bodega (`source_warehouse_id`). `to_pick`: pagados o contra entrega en `created`; `picking`: `preparing` con el envío aún `pending`. Orden: franja más próxima, luego antigüedad. `{ items, total }` |
| `GET /fulfillment/picking/:orderId` | Detalle con sku, código de barras, imagen, color y talla de cada línea (el front verifica cada escaneo) |
| `POST /fulfillment/picking/:orderId/start` `{ version }` | Pedido → `preparing` (idempotente si ya lo está; 409 `STALE_VERSION`) |
| `POST /fulfillment/picking/:orderId/complete` `{ items: [{ orderItemId, pickedQuantity }] }` | Exige las unidades exactas (422 `PICK_EXCESS` / `PICK_INCOMPLETE` con el detalle; 409 `PICK_NOT_STARTED`). El envío pasa `pending → ready_for_pickup` (evento `ShipmentStatusChanged`); en retiro en tienda se crea el envío `pickup` ya listo con la tienda como destino. Idempotente. Auditado: `fulfillment.picking.completed` |

El pedido sigue en `preparing`: el motorizado lo retira (`picked_up` → `shipped`) o, en tienda, el
mostrador lo entrega (`preparing → delivered`). Limitación: un pedido al que ya se le asignó motorizado
antes de terminar el picking sale de la cola `picking` y su envío no cambia al cerrar.

```bash
npx jest -c jest.unit.config.js libs/modules/fulfillment
npx jest -c jest.int.config.js test/fulfillment
```

## Módulo Facturación (`libs/modules/billing`) — factura electrónica SRI

Schema `billing`: `emission_points`, `sequences`, `electronic_documents` y `electronic_document_lines`. Lee los pedidos
solo por `OrdersApi`. La migración `1759000000007` agrega el índice único parcial `ux_ed_order_invoice`, que garantiza una
factura por pedido, y el permiso `billing.read`. No cambia tablas ni columnas.

### Flujo

1. **`OrderPaid` → `InvoiceIssuer`**, dentro de la transacción del relay. En contra entrega, Pedidos emite `OrderPaid`
   al entregar, así que no se escucha `OrderDelivered` (se facturaría dos veces). En la misma transacción ocurren cuatro
   pasos:
   - `UPDATE billing.sequences SET last_value = last_value + 1 ... RETURNING` (patrón 3 de docs/03). La fila queda
     bloqueada hasta el COMMIT, así que los secuenciales salen en orden y sin huecos.
   - Se arma la clave de acceso de 49 dígitos con dígito verificador módulo 11 (`domain/access-key.ts`).
   - Se construye la factura desde el snapshot del pedido (`domain/invoice.ts`).
   - Se hace el `INSERT` del documento con sus líneas en estado `pending`.

   El `INSERT` corre en un savepoint. Si choca con `ux_ed_order_invoice` porque otro worker facturó el mismo pedido, se
   revierte también el incremento del secuencial y se devuelve la factura existente. Aquí no hay I/O externo.
2. **Job `process-electronic-documents`** (worker, cada `SRI_PROCESS_EVERY_MS`). Toma los comprobantes vencidos con
   `SKIP LOCKED` y un préstamo de `next_retry_at` de 2 min, y los avanza paso a paso, fuera de transacción:

   | Estado | Paso | Resultado |
   |---|---|---|
   | `pending` | Arma el XML 2.1.0 en forma canónica (`domain/invoice-xml.ts`), lo firma con XAdES-BES (`infrastructure/signing/xades.ts`) y lo guarda en SeaweedFS | `signed` |
   | `signed` / `sent` | `validarComprobante` | RECIBIDA → `received`. DEVUELTA → `returned` + `InvoiceRejected`. DEVUELTA 43/70 (clave ya registrada o en proceso: reenvío tras un timeout) cuenta como recibida |
   | `received` | `autorizacionComprobante` | AUTORIZADO → genera el RIDE (PDF), guarda el XML autorizado y el RIDE → `authorized` + `InvoiceAuthorized`. NO AUTORIZADO → `not_authorized` + `InvoiceRejected`. En proceso → espera |
   | `authorized` sin `emailed_at` | Email con RIDE y XML al comprador (Nodemailer → Mailpit) | `emailed_at` (hasta 8 intentos) |

   Los errores transitorios (red, 5xx, SOAP Fault) suman `attempts` y reprograman `next_retry_at` con backoff
   exponencial: `SRI_RETRY_BASE_SECONDS` × 2^(intentos − 1), con tope en `SRI_RETRY_MAX_SECONDS` (30 s, 1 min,
   2 min... 1 h). Un timeout esperando la recepción deja el comprobante en `sent`, porque pudo llegar: se reenvía.
   Cada resultado se guarda con un `UPDATE` condicionado al estado leído, junto con su evento en el outbox.

### Decisiones

| Tema | Decisión |
|---|---|
| Firma sin librerías | El XML se escribe directamente en forma canónica (C14N 1.0: atributos ordenados, sin `<a/>`, sin espacios entre elementos, escapes de C14N). Así el digest es el SHA-1 de los bytes escritos. Las partes de la firma se canonicalizan con los `xmlns:ds`/`xmlns:etsi` heredados. La firma se verificó con tres implementaciones: los tests, el SRI simulado (parser y C14N propios) y `xmlsec1` |
| Certificado | Autofirmado con OpenSSL (`npm run sri:cert` → `secrets/sri/`, fuera de git). El SRI real exige una `.p12` de una entidad acreditada. El script genera también la `.p12`, pero el backend lee PEM porque Node no abre PKCS#12 sin dependencias |
| Consumidor final | Sin identificación, la factura va a `07` / `9999999999999` / CONSUMIDOR FINAL. El SRI limita esas facturas a `SRI_CONSUMIDOR_FINAL_MAX` (USD 50; 0 = sin límite). Checkout valida **antes de vender** con `BillingApi.assertBuyerCanBeInvoiced`: por encima del límite responde 422 `BILLING_ID_REQUIRED` para que el storefront pida la cédula, y una cédula o RUC inválidos responden 422 `INVALID_BUYER_ID`. No se reserva nada. La venta no se bloquea: con el dato, pasa |
| Envío y gift card | El envío va como línea `ENVIO` con IVA 0 %, porque el pedido no le cobra IVA (transporte de carga). La gift card es una forma de pago (18) y el `importeTotal` la incluye |
| Formas de pago (tabla 24) | `card` 19 · `deuna`, `pichincha`, `transfer`, `qr` 20 · `cod` 01 · `gift_card` 18 |
| Emisor | RUC, razón social, dirección matriz y demás salen de variables `SRI_*`, porque Facturación no puede leer `iam.tenants` (otro schema). La dirección del establecimiento sale de `billing.emission_points` |
| Archivos | En SeaweedFS, bajo `billing/<tenant>/<aaaa>/<mm>/<clave>/`: `firmado.xml`, `autorizado.xml` (envoltura `<autorizacion>` como la entrega el SRI) y `ride.pdf`. El RIDE es un PDF propio con código de barras Code 128 de la clave de acceso, verificado con `zbarimg` |
| Mismo adaptador para el SRI real | `SriSoapAdapter` habla el SOAP offline del SRI. `SRI_MODE=pruebas` o `produccion` solo cambia la URL (celcer / cel) |

### Permisos y endpoints (`/v1/...`)

| Método y ruta | Quién |
|---|---|
| `GET /billing/documents?status&orderId&limit&offset` · `GET /billing/documents/:id` (con líneas) | `billing.read` |
| `GET /billing/documents/:id/xml` · `GET /billing/documents/:id/ride.pdf` | `billing.read` |
| `GET /me/orders/:orderId/invoice` · `.../invoice/ride.pdf` · `.../invoice/xml` | Cliente dueño del pedido. Un pedido ajeno responde 404; los archivos, solo si la factura está autorizada |

`BillingApi` (fachada para otros módulos): `assertBuyerCanBeInvoiced`, `issueForOrder` y `listForOrder`. Eventos:
`InvoiceAuthorized` e `InvoiceRejected`.

### Cómo probar Facturación

```bash
npx jest -c jest.unit.config.js libs/modules/billing    # clave de acceso (casos conocidos), XML, firma, RIDE, SOAP
npx jest -c jest.int.config.js test/billing             # emisión, concurrencia, SRI falso (DEVUELTA, timeout, caído), email
npx jest -c jest.int.config.js -t "20 facturas concurrentes"
cd ../simulators/sri && node --test                     # SRI simulado: ficha técnica, firma, SOAP
```

De punta a punta, con Docker:

```bash
cd backend && npm run sri:cert                           # certificado autofirmado en secrets/sri/
cd .. && docker compose up -d postgres valkey seaweedfs mailpit
docker compose --profile sims up -d sri-simulado
cd backend && npm run migrate:up && npm run seed:dev     # crea el punto de emisión 001-001
# backend/.env: SRI_URL=http://localhost:8083, DOCUMENT_STORAGE=seaweedfs, SMTP_URL=smtp://localhost:1025
npm run dev:worker                                       # en otra terminal: npm run dev:api
TOKEN=$(npm run -s token:dev -- <tenantId> <userId>)
curl -X POST localhost:3000/v1/orders/5eed0000-0000-4000-8000-000000000001/status \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"to":"paid","version":0}'
# En unos segundos: factura autorizada, email en http://localhost:8025, estado en el simulador:
curl -H "Authorization: Bearer $TOKEN" 'localhost:3000/v1/billing/documents?orderId=5eed0000-0000-4000-8000-000000000001'
curl localhost:8083/admin/comprobantes
```

## Devoluciones y cambios (`libs/modules/aftersales` + Pedidos, Logística, Inventario, Pagos, Facturación)

Los datos viven en los schemas de siempre: `sales.returns` y `sales.return_items` (Pedidos), `logistics.shipments` con
`direction` `return` / `exchange`, `inventory.stock_movements`, `payments.refunds` y `billing.electronic_documents` tipo
`04`. La migración `1759000000008` agrega permisos, índices únicos de idempotencia (`ux_refunds_return`,
`ux_ship_return_direction`, `ux_ed_return_credit_note`), índices de consulta, dos CHECK (`0 <= qty_returned <= quantity`,
`refund_amount >= 0`) y el secuencial `04` de los puntos de emisión existentes. **No cambia tablas ni columnas.**

`aftersales` es un orquestador sin schema, como Checkout: cada paso compone en **una** transacción las fachadas públicas
de Pedidos, Catálogo, Inventario, Logística, Pagos y Promociones. Nadie lo importa, así que depende de todos sin ciclos
entre módulos (Logística ya importa Pedidos: Pedidos no puede llamar a Logística).

### Flujo

```text
cliente: fotos + solicitud ──▶ requested ──aprobar──▶ approved ─(retiro Logística)─▶ pickup_scheduled ──▶ received
                                   └──rechazar──▶ rejected ◀──── inspección fallida ─────────────────────┘      │
                                                                                                     inspección│
                              devolución: reembolso (Pagos) ◀── inspected ──▶ cambio: talla nueva (Inventario + Logística)
                                    │                                                        │
                                refunded + nota de crédito 04                            exchanged
```

| Paso | Endpoint | Efectos (una transacción) |
|---|---|---|
| Foto | `POST /me/returns/photos` (multipart `photo`: jpg, png, webp, 5 MB) | Se guarda en SeaweedFS (`returns/photos/<tenant>/<cliente>/...`) y devuelve la clave |
| Solicitud | `POST /me/orders/:orderId/returns` | Pedido entregado y dentro de `RETURN_WINDOW_DAYS` (30). Cantidades ≤ compradas − devueltas − ya solicitadas. Motivos `size_small`, `size_large`, `defect`, `not_as_described`, `wrong_item`, `changed_mind`, `other`; los imputables a la tienda exigen foto y la tienda paga el retiro. `resolution`: `refund_original` o `store_credit`. En un cambio, `exchangeVariantId` debe ser otra talla del **mismo producto**, vendible y con stock (409 `EXCHANGE_OUT_OF_STOCK`). RMA `RMA-<pedido>-<n>` |
| Registro por soporte | `POST /returns` (`returns.approve`) | El mismo cuerpo más `orderId`: soporte la registra por el cliente (pedidos de invitado, llamadas). Sin fotos; los motivos imputables a la tienda no las exigen (se verifican en la inspección) |
| Aprobación | `POST /returns/:id/approve` | `approved` → Logística crea el envío `pending` con `direction = 'return'` (en un retiro, `destination` es la dirección del cliente y `origin_warehouse_id` la bodega que recibe; en retiro en tienda, el cliente lo entrega en la tienda) → `pickup_scheduled` |
| Recepción | `POST /returns/:id/receive` (`warehouseId` opcional) | `received` y el retiro pasa a `delivered` |
| Inspección | `POST /returns/:id/inspect` (`condition` new/used/damaged y `restock` por línea) | `inspected`. Lo que tiene `restock` vuelve a `on_hand` de la bodega que lo recibió (movimiento `return`). **Devolución:** `qty_returned` sube, el pedido pasa a `partially_returned` o `returned` y se solicita el reembolso por el valor pagado de las unidades (descuento prorrateado + IVA, el mismo cálculo que la nota de crédito). **Cambio:** sale la talla nueva (movimiento `sale`, referencia `exchange`) y Logística crea el envío `direction = 'exchange'` con la variante nueva → `exchanged`. Sin stock en ese momento, queda `inspected` y se reintenta con `POST /returns/:id/exchange-shipment` |
| Aprobación del reembolso | `POST /refunds/:id/approve` | Ver abajo |
| Reembolso completo | evento `RefundSucceeded` | Pedidos: devolución `refunded`; pedido `partially_refunded` o `refunded` (sobre la mercadería: el envío no se reembolsa). Facturación: nota de crédito |

Consultas: `GET /returns?status&orderId`, `GET /returns/:id` (con retiro, envío de cambio y reembolso), la foto con
`GET /returns/:id/items/:itemId/photos/:n` y, para el cliente, `GET /me/returns` y `GET /me/returns/:id`.

### Reembolsos (Pagos)

| Resolución y pago | Método | Cómo se ejecuta |
|---|---|---|
| `store_credit` | `gift_card` | Gift card nueva por el monto. El código se envía por email **en la misma transacción**: si el SMTP falla, no se emite la tarjeta y se reintenta, así el código nunca se pierde |
| `refund_original`, pago en línea (tarjeta, DeUna, Pichincha, QR) | `original` | Reverso en la pasarela (`POST /refunds` del simulador, cuerpo firmado con HMAC, idempotente por `refundId`), fuera de la transacción. Si no responde, el job `retry-gateway-refunds` reintenta cada minuto; si lo rechaza, `failed` + `RefundFailed` |
| `refund_original`, pago con gift card | `original` | Saldo de vuelta a las gift cards del pedido |
| `refund_original`, contra entrega o transferencia | `transfer` | Finanzas transfiere y lo registra con `POST /refunds/:id/transfer/complete` (`bankName`, `reference`) |

Si parte del pedido se pagó con gift card, lo que excede lo cobrado en el pago vuelve a esas tarjetas.

**Aprobación:** hasta `REFUND_DUAL_APPROVAL_ABOVE` ($100.00, inclusive) basta una; por encima hacen falta dos personas
distintas (409 `REFUND_SECOND_APPROVER_REQUIRED`). Nunca aprueba quien inspeccionó (409 `REFUND_SELF_APPROVAL`). La tabla
no tiene columnas para las aprobaciones, el plan de ejecución (parte externa, gift cards, saldo a favor) ni las partes
ejecutadas, así que quedan en la bitácora del pago (`payments.payment_events`, tipos `refund_*`). El pago pasa a
`partially_refunded` o `refunded` según lo que salió de él.

### Nota de crédito (Facturación)

`RefundSucceeded` llega a `CreditNoteIssuer`, en la transacción del relay: secuencial `04`, clave de acceso con código
`04`, documento con `return_id` y `modified_document_id` (la factura vigente del pedido) y las líneas de la devolución.
El job firma el XML **notaCredito 1.1.0** (`codDocModificado` 01, `numDocModificado`, `fechaEmisionDocSustento`,
`valorModificacion`, `motivo`), pero antes espera a que la factura esté autorizada. Después genera el RIDE ("NOTA DE
CRÉDITO", con el comprobante modificado y la razón) y lo envía por email.

Se valida que el total sea igual a lo reembolsado y que, sumado a las notas de crédito anteriores, no supere la factura.
El SRI no admite notas de crédito a consumidor final: en ese caso no se emite y queda una advertencia en el log. Un
cambio de talla no lleva nota de crédito, porque la venta no cambia de valor.

### Permisos

`returns.read`, `returns.approve` (aprobar o rechazar), `returns.inspect` (recepción, inspección y reintento del
cambio), `payments.refund.approve` y `payments.refund.complete`. `GET /refunds` y `GET /refunds/:id` piden
`payments.read`.

### Cómo probar Devoluciones

```bash
npx jest -c jest.unit.config.js libs/modules/orders/domain/return.spec.ts libs/modules/payments/domain/refund.spec.ts libs/modules/billing
npx jest -c jest.int.config.js test/aftersales     # de punta a punta: checkout real, retiro, stock, reembolsos, nota de crédito
cd ../simulators/payments && node --test           # reversos en la pasarela simulada
cd ../simulators/sri && node --test                # nota de crédito firmada por el backend
```

A mano, con Docker (después de `seed:dev`, con un pedido entregado del cliente `customerId`):

```bash
docker compose --profile sims up -d pasarela-simulada sri-simulado
STAFF=$(npm run -s token:dev -- <tenantId> <userId>)
APROBADOR=$(npm run -s token:dev -- <tenantId> <otroUserId>)   # no puede aprobar quien inspecciona
CLIENTE=$(npm run -s token:dev -- <tenantId> <customerId> --customer)
curl -X POST localhost:3000/v1/me/orders/<orderId>/returns -H "Authorization: Bearer $CLIENTE" -H 'content-type: application/json' \
  -d '{"type":"return","items":[{"orderItemId":"<orderItemId>","quantity":1,"reasonCode":"size_small"}]}'
curl -X POST localhost:3000/v1/returns/<returnId>/approve -H "Authorization: Bearer $STAFF"
curl -X POST localhost:3000/v1/returns/<returnId>/receive -H "Authorization: Bearer $STAFF"
curl -X POST localhost:3000/v1/returns/<returnId>/inspect -H "Authorization: Bearer $STAFF" -H 'content-type: application/json' \
  -d '{"items":[{"returnItemId":"<returnItemId>","condition":"new","restock":true}]}'
curl -X POST localhost:3000/v1/refunds/<refundId>/approve -H "Authorization: Bearer $APROBADOR"
curl -H "Authorization: Bearer $STAFF" 'localhost:3000/v1/billing/documents?docType=04'   # nota de crédito
curl localhost:8081/refunds                                                                # reverso en la pasarela
```

## Módulo IAM (`libs/modules/iam`) — terminado

Registro, login, sesiones con refresh tokens, RBAC, 2FA TOTP y consentimientos LOPDP (schema `iam`). Migración
`0014` (permisos nuevos y particiones de `platform.audit_log`); no cambia tablas ni columnas.

### Autenticación

| Tema | Decisión |
|---|---|
| Guard global | `GlobalAuthGuard` (APP_GUARD en `AppModule`): **cerrado por defecto**, toda ruta exige un JWT de acceso válido. Las abiertas llevan `@Public()`: registro, login, refresh, logout, `GET /v1/health`, webhook de pagos (lo autentica la firma HMAC), clave VAPID y enlaces de tickets de invitado. `@OptionalAuth()` implica `@Public()` (carrito, checkout y pago de invitado, saldo de gift card, lectura de reseñas y preguntas). |
| Contraseña | argon2id (`argon2`, m=19 MiB, t=2, p=1, mínimo OWASP). Mínimo 10 y máximo 128 caracteres Unicode, sin reglas de composición (NIST 800-63B). Si no cumple: 422 `PASSWORD_TOO_SHORT` / `PASSWORD_TOO_LONG`. |
| Registro | Crea un `customer` `active` con el rol `customer`, en el tenant del header `X-Tenant-Id`, junto con sus consentimientos, todo en una transacción. Email recortado y en minúsculas. Único por tenant (`UNIQUE (tenant_id, email)` sobre citext): 409 `EMAIL_TAKEN`. Tenant inexistente o suspendido: 422 `TENANT_UNAVAILABLE`. Sin verificación de email todavía (`emailVerified: false`). |
| Login | `{ accessToken, tokenType: 'Bearer', expiresIn: 900 }` (JWT de 15 min) + cookie `refresh_token`. Con 2FA, o con el rol admin: `{ mfaRequired \| mfaSetupRequired: true, mfaToken, expiresIn: 300 }` y todavía sin sesión. Email inexistente, contraseña errónea, cuenta `pending`/`blocked`/`anonymized`, borrada o sin contraseña: el mismo 401 `INVALID_CREDENTIALS`. Si el email no existe, igual se verifica contra un hash ficticio para no delatarlo por el tiempo de respuesta. |
| Bloqueo | Al 5.º fallo seguido (de contraseña **o de código TOTP**): `locked_until = now + 15 min`, `failed_logins = 0` y 423 `ACCOUNT_LOCKED` (con `details.lockedUntil`). Mientras dure el bloqueo, también se rechaza la credencial correcta, y esos intentos no lo alargan. El contador solo se reinicia con un login **completo**: la contraseña correcta con el 2FA pendiente no lo reinicia, así no se pueden probar códigos sin límite. El fallo se registra con `SELECT … FOR UPDATE`, así los intentos simultáneos no se pierden. El 423 sí revela que la cuenta existe: es el costo de avisarle al dueño. |

### Sesiones: refresh tokens rotativos

| Tema | Decisión |
|---|---|
| Token | 32 bytes aleatorios (base64url). `iam.refresh_tokens` guarda solo el **SHA-256** (`token_hash`), con `family_id` (la sesión que nació en un login), `user_agent`, IP y `expires_at` (14 días, `REFRESH_TOKEN_TTL_DAYS`, se renueva al rotar). |
| Cookie | `refresh_token`: `HttpOnly` (un XSS no la lee), `SameSite=Strict` (otro sitio no la envía, así que no hay CSRF), `Secure` (salvo `SECURE_COOKIES=false`) y `Path=/v1/auth` (`REFRESH_COOKIE_PATH`; detrás de Caddy, `/api/v1/auth`): no viaja a ninguna otra ruta. El access token va en el cuerpo y el frontend lo guarda en memoria. |
| Rotación | `POST /auth/refresh` revoca el token presentado e inserta su sucesor en la misma familia (con `FOR UPDATE`). El nuevo access token **recarga los permisos** desde los roles. |
| Reutilización | Presentar un token ya revocado (rotado o cerrado) significa que una copia anda suelta: se revoca **toda la familia** (también el token vigente), se registra `auth.refresh_reused` en `platform.audit_log` y se responde 401 `REFRESH_TOKEN_REUSED` con la cookie borrada. Las otras sesiones del usuario (otras familias) siguen vivas. |
| Otros 401 | `REFRESH_TOKEN_INVALID` (sin cookie o token desconocido), `REFRESH_TOKEN_EXPIRED` (lo revoca) y `USER_INACTIVE` (cuenta bloqueada o borrada: revoca la familia). En todos se borra la cookie. |
| Limitación | Dos pestañas que refrescan a la vez parecen una reutilización y cierran esa sesión (no hay columna para un período de gracia). El frontend debe hacer el refresh de a uno (*single-flight*). |
| Logout | `POST /auth/logout` revoca la familia de la cookie (204, idempotente). `POST /auth/logout-all` (con access token) revoca todas las sesiones del usuario. Los access tokens ya emitidos vencen solos en ≤ 15 min. |

### RBAC: roles, permisos y auditoría

| Tema | Decisión |
|---|---|
| Roles como datos | Los 7 roles del enunciado son filas de `iam.roles` (`is_system = true`) por tenant, con sus permisos en `iam.role_permissions`. La fuente de verdad es `domain/system-roles.ts`: `RoleService.ensureSystemRoles` los sincroniza (crea, renombra y deja los permisos exactamente como en el código) la primera vez que el proceso usa el tenant. |
| Permisos | Por código en `iam.permissions` (sembrado por las migraciones de cada módulo). Un test verifica que el catálogo del código y la tabla coinciden. |
| Permisos **en el JWT** (no cache en Valkey) | El token ya llevaba `perms` y el guard los leía: no hace falta consultar Valkey en cada petición ni invalidar una cache en cada cambio. El costo es que un rol quitado sigue valiendo hasta que vence el access token (≤ 15 min), porque cada refresh recarga los permisos. Para una baja urgente: `POST /auth/logout-all` del usuario o resetearle el 2FA. |
| Decorador | `@RequirePermission('catalog.product.write')` exige TODOS los permisos indicados; lo verifica el `PermissionGuard` global (después del guard de autenticación) y responde 403 con los que faltan. `@Auth(...)` queda como alias para las rutas existentes. Las rutas de escritura de Catálogo (moderación de reseñas y respuestas a preguntas) ya usan `@RequirePermission`. |
| Reglas | Nadie cambia sus propios roles (403 `CANNOT_CHANGE_OWN_ROLES`). El rol debe corresponder al tipo de usuario: `customer` solo a clientes, `rider` solo a motorizados y el resto solo a staff (422 `ROLE_NOT_ALLOWED_FOR_USER_TYPE`). No se quita el admin al último administrador activo (409 `LAST_ADMIN`; cuenta los **otros** admins activos, así lo protege también de alguien con un token viejo). Los cambios del tenant se serializan con `pg_advisory_xact_lock`. |
| Auditoría | Cada asignación o retiro escribe `iam.role.assigned` / `iam.role.removed` en `platform.audit_log` (actor, IP, `before` y `after`) en la misma transacción. Asignar un rol que ya tiene es idempotente y no audita. `AuditLog` vive en el shared kernel. La tabla está particionada por mes: la migración `0014` crea las particiones hasta 2027-12 y el job diario `ensure-audit-partitions` del worker mantiene 3 meses por delante. |

| Rol | Tipo | Permisos |
|---|---|---|
| `admin` (Administrador) | staff | Todos (incluidos `iam.roles.assign` e `iam.mfa.reset`). 2FA obligatorio. |
| `manager` (Gerente) | staff | Reportes, promociones y gift cards, CRM, catálogo, lectura de pedidos, inventario, pagos, facturación, logística y notificaciones; cancelar pedidos, aprobar devoluciones, reembolsos y liquidaciones; `iam.roles.read` |
| `seller` (Vendedor) | staff | `catalog.*` (productos, moderación de reseñas, respuestas), lectura de inventario, pedidos, promociones, gift cards y CRM |
| `warehouse` (Bodega) | staff | `inventory.*`, lectura y cambio de estado de pedidos, lectura e inspección de devoluciones, lectura de logística |
| `support` (Soporte) | staff | `support.tickets.*`, lectura de pedidos, devoluciones (y aprobarlas), pagos, facturación, CRM, gift cards y notificaciones; responder preguntas |
| `rider` (Motorizado) | rider | Ninguno de backoffice: `/rider/...` se autoriza por el tipo de usuario |
| `customer` (Cliente) | customer | Ninguno de backoffice: `/me/...` se autoriza por el tipo de usuario |

### 2FA TOTP

| Tema | Decisión |
|---|---|
| Algoritmo | RFC 6238 (HMAC-SHA1, 6 dígitos, 30 s, ±1 paso), implementado sobre `node:crypto` y probado con los vectores de RFC 4226/6238. Secreto de 20 bytes. Compatible con Aegis, FreeOTP y Google Authenticator. |
| Secreto cifrado | `mfa_secret_enc` = nonce (24 B) ‖ `crypto_secretbox` de **libsodium** (XSalsa20-Poly1305) con `MFA_ENCRYPTION_KEY` (32 bytes en base64, gestionada con SOPS según docs/02). Es obligatoria en producción; en desarrollo, si falta, se deriva de `JWT_SECRET` con un aviso en el log. Un byte alterado hace fallar el descifrado. |
| Alta | `setup` genera el secreto **pendiente** (`mfa_enabled = false`) y devuelve el QR (`qrCodeDataUrl`, PNG con `qrcode`), la URI `otpauth://` y el secreto en base32. `activate` lo confirma con el primer código. Repetir `setup` reemplaza el secreto pendiente. |
| Login en dos pasos | Contraseña correcta → `mfaToken` (JWT de 5 min, firmado con `MFA_CHALLENGE_SECRET` —por defecto derivado de `JWT_SECRET`— y con audiencia `iam.mfa`: no sirve como Bearer). Con `mfaRequired`, `POST /auth/login/mfa`. Con `mfaSetupRequired` (admin sin 2FA), `POST /auth/mfa/setup` y luego `/auth/mfa/activate`, que abre la sesión. |
| Anti-replay | Cada paso de 30 s se acepta una sola vez por usuario: `SET iam:totp:<usuario>:<paso> NX EX 120` en **Valkey** (sin columna nueva; vale entre réplicas). |
| Obligatorio para admin | Un admin siempre pasa por el segundo paso y no puede desactivarlo (403 `MFA_REQUIRED_FOR_ROLE`). El resto de usuarios lo activa desde Mi cuenta si quiere. |
| Recuperación | No hay tabla de códigos de recuperación: otro admin lo resetea (`iam.mfa.reset`, auditado como `iam.mfa.reset`), lo que además cierra todas las sesiones del usuario. Nadie resetea su propio 2FA. Activar y desactivar también quedan auditados. |

### Consentimientos LOPDP

| Tema | Decisión |
|---|---|
| Registro | El cuerpo lleva `consents: { terms, privacy, marketingEmail?, marketingWhatsapp?, marketingSms? }`. Términos y privacidad son obligatorios: sin el bloque, 400; si alguno es `false`, 422 `CONSENT_REQUIRED` y la cuenta no se crea. Se guarda una fila por propósito contestado con `policy_version` (`POLICY_VERSION`, por defecto `2026-10`) y la IP. Lo que el cliente no contestó no se registra: sin fila, el propósito **no** está otorgado (opt-in). |
| Mi cuenta | `GET /me/consents` muestra el estado vigente (manda la fila más reciente). `PUT /me/consents` agrega filas nuevas (historial de solo inserción). Revocar términos o privacidad da 422 `CONSENT_NOT_REVOCABLE`: retirarlos equivale a pedir la supresión de la cuenta, que es otro flujo. |
| Otros módulos | `IamApi.getContact` (email, teléfono, nombre, idioma; `null` si el usuario fue anonimizado) e `IamApi.hasConsent` (Notificaciones no envía marketing sin consentimiento). |

### Endpoints (`/v1/...`)

| Método | Ruta | Acceso | Uso |
|---|---|---|---|
| POST | `/auth/register` | público + `X-Tenant-Id` | `{ email, password, firstName, lastName, phone, consents }` → 201 con el perfil |
| POST | `/auth/login` | público + `X-Tenant-Id` | `{ email, password }` → sesión, o `mfaRequired` / `mfaSetupRequired` + `mfaToken` |
| POST | `/auth/login/mfa` | público | `{ mfaToken, code }` → sesión |
| POST | `/auth/mfa/setup` · `/auth/mfa/activate` | público | Alta obligatoria del admin durante el login: `{ mfaToken }` → QR; `{ mfaToken, code }` → sesión |
| POST | `/auth/refresh` | cookie | Rota el refresh token → access token nuevo |
| POST | `/auth/logout` | cookie | Cierra la sesión de este dispositivo (204) |
| POST | `/auth/logout-all` | token | Cierra todas las sesiones → `{ revokedSessions }` |
| GET | `/me` | token | Perfil (con `mfaEnabled`, sin hash). 401 si el usuario fue borrado después de emitir el token |
| POST · POST · DELETE | `/me/mfa/setup` · `/me/mfa/activate` · `/me/mfa` | token | 2FA voluntario: QR; `{ code }` activa; `{ code }` desactiva |
| GET · PUT | `/me/consents` | token (cliente) | Consultar y modificar consentimientos |
| GET | `/iam/roles` | `iam.roles.read` | Roles del tenant con sus permisos |
| GET | `/iam/users/:id/roles` | `iam.roles.read` | Roles de un usuario |
| PUT · DELETE | `/iam/users/:id/roles/:code` | `iam.roles.assign` | Asignar o quitar un rol (auditado) |
| POST | `/iam/users/:id/mfa/reset` | `iam.mfa.reset` | Resetear el 2FA de otro usuario (auditado, cierra sus sesiones) |
| GET | `/iam/users?q=&type=&status=&role=&limit=&offset=` | `iam.users.read` | Gestión de usuarios: `{ items, total }` (más recientes primero; `q` busca en email, nombre, apellido y teléfono; sin `status` excluye anonimizados) |
| GET | `/iam/users/:id` | `iam.users.read` | Ficha del usuario (roles, 2FA, último login, `lockedUntil`) |
| POST | `/iam/users` | `iam.users.write` + `iam.roles.assign` | Alta de personal `{ email, firstName, lastName, phone?, roles }` (solo roles de staff) → 201 `{ user, temporaryPassword }`; 409 `EMAIL_TAKEN` |
| POST · POST | `/iam/users/:id/block` · `/unblock` | `iam.users.write` | Bloquear (cierra sus sesiones; 409 `LAST_ADMIN`) o desbloquear. 403 sobre uno mismo; 422 si está anonimizado |
| POST | `/iam/users/:id/password-reset` | `iam.users.write` | Nueva contraseña temporal `{ temporaryPassword }`; cierra sesiones y limpia el bloqueo por intentos |
| GET | `/health` | público | `{ status: 'ok', database: 'up' }` o 503 |

### Usuarios de prueba (`npm run seed:dev`)

**Solo para desarrollo.** Tenant `demo` (el seed imprime su `tenantId`). Todos usan la contraseña **`Demo-2026-segura`**.

| Rol | Email | Notas |
|---|---|---|
| admin | `admin@demo.test` | 2FA activo con el secreto fijo **`NVXWIYJNMRSW23ZNMFSG22LOFUZGMYJB`**: cárgalo en tu app autenticadora (o pega la `otpauthUrl` que imprime el seed) |
| manager | `gerente@demo.test` | |
| seller | `vendedor@demo.test` | |
| warehouse | `bodega@demo.test` | |
| rider | `moto@demo.test` | Tiene ficha de motorizado (Quito Norte) |
| support | `soporte@demo.test` | |
| customer | `cliente@demo.test` | Con términos y privacidad aceptados |

Un secreto TOTP publicado no protege nada: es solo para probar el login en dos pasos. `npm run token:dev` sigue
disponible para emitir tokens con permisos a medida sin pasar por el login.

La contraseña temporal (alta o reseteo, 20 caracteres con `crypto.randomInt`) se devuelve una sola vez y nunca se
audita; el admin la entrega al usuario por un canal aparte. Cambios auditados en `platform.audit_log`:
`iam.user.created`, `iam.user.blocked`, `iam.user.unblocked`, `iam.user.password_reset`.

### Cómo probar IAM

```bash
npx jest -c jest.unit.config.js libs/modules/iam      # contraseña, bloqueo, rotación, roles, TOTP (vectores RFC), libsodium, consentimientos
npx jest -c jest.int.config.js test/iam               # registro, login, sesiones, RBAC por rol, 2FA y consentimientos
```

## Módulo Notificaciones (`libs/modules/notifications`)

Dueño de `platform.notification_templates`, `platform.notifications` y `platform.push_subscriptions`.

### Flujo en dos fases

1. **Encolar** (`NotificationService.notify`), dentro de la transacción del relay del outbox: destinatarios por canal,
   plantilla del idioma del usuario, consentimiento (solo marketing), render y `INSERT … ON CONFLICT (tenant_id,
   dedupe_key) DO NOTHING`. Sin consentimiento la fila queda `suppressed` (evidencia), no se envía.
2. **Despachar** (`NotificationDispatcher`, job `dispatch-notifications` cada 5 s), fuera de toda transacción: toma las
   filas `queued` vencidas con `SKIP LOCKED` y un lease sobre `next_attempt_at`, envía por el `ChannelPort` y marca
   `sent`; si falla, reintenta con backoff (`attempts`, `next_attempt_at`) o queda `failed` (error permanente o
   intentos agotados). Un 404/410 de Web Push borra la suscripción.

`dedupe_key` = `código:fuente:canal:hash(destinatario)`. La fuente es el pedido, el envío + fecha del estado, el
comprobante o el carrito + su última actividad: un evento repetido nunca duplica mensajes.

### Canales (`ChannelPort`)

| Canal | Adaptador | Desarrollo |
|---|---|---|
| email | Nodemailer (SMTP) | Mailpit, bandeja en http://localhost:8025 |
| webpush | `web-push` con VAPID (sin Firebase) | claves con `npm run vapid:keys` |
| ntfy | HTTP JSON al servidor ntfy | http://localhost:8090, tópico `NTFY_STAFF_TOPIC` |
| whatsapp / sms | **Simulados**: registran el mensaje en el log del worker | `[WhatsAppSimulado]` / `[SmsSimulado]` |

Con `NOTIFICATION_TRANSPORT=memory` (tests) email, Web Push y ntfy quedan en memoria.

### Plantillas Handlebars por canal e idioma

El catálogo (`domain/catalog.ts`) fija qué mensajes existen, su **categoría** y sus canales. Las plantillas del sistema
(`infrastructure/templates/defaults.ts`) vienen en `es-EC` y `en-US`; un tenant puede reemplazar cualquiera
(`PUT /v1/notifications/templates/:code/:channel/:locale`; `active=false` apaga ese mensaje en ese canal). Búsqueda:
idioma exacto del usuario → mismo idioma soportado → `es-EC`. El email se escapa y va en un layout con versión de
texto; WhatsApp, SMS, push y ntfy son texto plano. Helpers: `money`, `fecha` (America/Guayaquil), `eq`; parcial `{{> items}}`.

| Evento | Mensaje | Canales |
|---|---|---|
| `OrderPlaced` | `order.placed` | email, webpush, WhatsApp |
| `OrderPaid` (no en contra entrega) | `order.paid` | email, webpush |
| `OrderCancelled` / `OrderDelivered` | `order.cancelled` / `order.delivered` | email, webpush |
| `ShipmentStatusChanged` | `shipment.<estado>` (no retiros, no cancelado, no la entrega de un pedido) | webpush (+ email / SMS según estado) |
| `InvoiceAuthorized` | `invoice.authorized` | webpush (el email con RIDE lo envía Facturación) |
| `InvoiceRejected` | `invoice.rejected` | ntfy al backoffice |
| `CartAbandoned` | `cart.reminder.1h` / `24h` / `72h` (**marketing**) | email, WhatsApp (+ SMS a las 72 h) |
| `TicketCreated` (cliente o agente, no los internos) | `ticket.created` (acuse con el enlace al ticket) | email |
| `TicketReplied` | `ticket.reply` (respuesta del agente) | email |
| `TicketClosed` | `ticket.csat` (encuesta: un enlace por puntaje) | email |
| `TicketSlaBreached` | `ticket.sla_breached` | ntfy al backoffice |

**Marketing:** email exige `marketing_email`, WhatsApp `marketing_whatsapp`, SMS `marketing_sms`. Web Push y ntfy no
llevan marketing (no hay propósito de consentimiento para ellos). La categoría la impone el catálogo: una plantilla
del tenant no puede volver transaccional un recordatorio.

### Carrito abandonado (módulo Carrito)

Job `remind-abandoned-carts` (cada `CART_REMINDER_EVERY_MS`, 5 min): carritos `active` con ítems y contacto (email o
teléfono del carrito, o usuario), tomados con `SKIP LOCKED`; `reminders_sent` sube con un UPDATE condicional y
`CartAbandoned` entra al outbox en la misma transacción. Si el job estuvo detenido, solo sale la etapa más avanzada
vencida. Tras el tercero no hay más; el carrito **sigue `active`** (pasarlo a `abandoned` lo sacaría de
`ux_cart_user_active` y el cliente perdería el carrito al que se le invita a volver). Cualquier actividad nueva
reinicia `reminders_sent` a 0.

### Permisos y endpoints (`/v1/...`)

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/notifications/push/public-key` | público |
| POST / DELETE | `/me/push-subscriptions` | autenticado |
| GET | `/me/notifications` | autenticado |
| GET | `/notifications?status=failed,suppressed&channel=email` | `notifications.read` |
| GET | `/notifications/templates` | `notifications.read` |
| PUT | `/notifications/templates/:code/:channel/:locale` | `notifications.templates.write` |

### Cómo probar Notificaciones

```bash
cd backend
npx jest -c jest.unit.config.js libs/modules/notifications libs/modules/iam libs/modules/cart/domain
npx jest -c jest.int.config.js test/notifications      # Testcontainers: no toca tu base local
npm run vapid:keys                                       # copia las 3 líneas a backend/.env
# Con la infraestructura del compose (mailpit, ntfy) y la base migrada:
npm run migrate:up && npm run dev:worker                 # despachador, carrito abandonado y relay
# Bandejas: Mailpit http://localhost:8025 · ntfy http://localhost:8090/moda-demo-backoffice · WhatsApp/SMS en el log del worker
```

## Módulo CRM y Fidelización (`libs/modules/crm`)

Schema `crm`: direcciones, wishlist, puntos, niveles y referidos. Lo importa solo Checkout (direcciones guardadas,
`CrmApi.getCheckoutAddress`); los efectos de Pedidos llegan por eventos (`CrmConsumersModule`) y los relojes corren en el
worker (`CrmWorkerModule`, cola `crm`).

Cambios al modelo (migración `1759000000010_crm-fidelizacion.js`, aprobados el 2026-10-01): `tenant_id` en las tablas
de `crm` (sin él, saber el tenant exigía un join con `iam.users`); `last_known_price`, `last_known_in_stock` y
`last_alerted_at` en `wishlist_items` (estado anterior para detectar reposición y bajada de precio); `reference` en
`loyalty_transactions` con índice único `(tenant, type, reference)` (idempotencia: un pedido puede tener varias
devoluciones y cada reversa se identifica por la suya; en los ajustes manuales guarda el motivo).

### Direcciones (`application/address.service.ts`)

- **Geocodificación en cascada** con `GeocoderPort` → `NominatimGeocoder` (`NOMINATIM_URL`, solo Ecuador, timeout 3 s,
  User-Agent): 1) número + calle principal → `rooftop` si el resultado es una casa; 2) calle principal → `street`;
  3) barrio o parroquia → `approximate`. Se descartan los resultados de otra ciudad (hay una "Av. Amazonas" en Quito y
  otra en Cuenca) y los de fuera de Ecuador. La ciudad sola no se usa: su centroide no sirve para entregar.
- **Pin manual** (`pin` al crear o `PUT /me/addresses/:id/location`): precisión `user_pin`, sin consultar Nominatim;
  rechaza puntos fuera de Ecuador continental y Galápagos (`LOCATION_OUT_OF_COUNTRY`).
- Si Nominatim no encuentra la dirección o no responde, **se guarda igual** con `needsPin: true`; `pinRecommended`
  avisa que la ubicación es aproximada. Cambiar calle, número, barrio o ciudad vuelve a geocodificar.
- Hasta 10 por cliente y una predeterminada (índice único parcial); al borrarla pasa a serlo la más reciente.
- **Checkout:** `POST /checkout/delivery-options` y `POST /checkout` aceptan `addressId` en lugar de `shippingAddress`
  (solo con sesión). Sin ubicación responde `ADDRESS_NEEDS_PIN`.

### Wishlist con alertas (`application/wishlist.service.ts`, `domain/wishlist.ts`)

Un ítem por producto (opcionalmente con talla/color). El job `scan-wishlists` (cada `WISHLIST_SCAN_EVERY_MS`) observa
precio (`CatalogApi.getProductOffers`) y stock (`InventoryApi.getAvailability`) en lote y compara con lo guardado:
agotado → disponible emite `WishlistBackInStock`; una baja de al menos `WISHLIST_PRICE_DROP_MIN_PERCENT` con stock
emite `WishlistPriceDropped`. Entre avisos del mismo ítem pasan `WISHLIST_ALERT_COOLDOWN_HOURS` (durante el
enfriamiento se conserva la referencia, así la rebaja se avisa al terminar). Observación y evento van en la misma
transacción. Es un job y no un consumidor de eventos porque el Catálogo aún no tiene escritura de precios.

### Puntos y niveles (`application/loyalty.service.ts`, `domain/loyalty.ts`)

- `OrderDelivered` → acumulación **pendiente**: mercadería (IVA incluido, sin envío) × `LOYALTY_POINTS_PER_USD` ×
  multiplicador del nivel, hacia abajo. `available_at` = entrega + `RETURN_WINDOW_DAYS`.
- `ReturnRefunded` → **reversa proporcional** al monto reembolsado, hacia arriba. Si la acumulación está pendiente, la
  reversa también (se netean); si ya se acreditó, se descuenta del saldo hasta donde alcance.
- Job `mature-loyalty-points` (cada `LOYALTY_MATURE_EVERY_MS`): acredita lo vencido salvo que el pedido tenga una
  devolución abierta (`requested` … `inspected`), porque un reembolso pedido dentro del plazo puede llegar después;
  en ese caso se pospone un día.
- **Niveles** por puntos históricos acreditados (`lifetime_points`), con multiplicador; no bajan (`LoyaltyTierChanged`).
- **Canje** por gift card (Promociones): bloques de 100 puntos = 1 USD, mínimo 500. El código se muestra una sola vez.

### Referidos (`application/referral.service.ts`)

Cada cliente tiene un código de 8 caracteres sin letras ambiguas. Quien aún no compró lo aplica una vez
(`SELF_REFERRAL`, `ALREADY_REFERRED`, `HAS_ORDERS`). Su primer pedido entregado de al menos `REFERRAL_MIN_ORDER` lo
**califica**; cuando ese pedido pasa el plazo de devolución sin devoluciones abiertas, el referente recibe un **cupón
personal de un uso** (`PromotionsApi.issueRewardCoupon`: promoción de sistema "Recompensa por referido" de
`REFERRAL_REWARD`, editable o desactivable desde el backoffice) y se emite `ReferralRewarded`. Si el pedido se devuelve
completo, el referido queda `rejected`.

### Permisos y endpoints (`/v1/...`)

| Permiso | Uso |
|---|---|
| `crm.read` | ficha del cliente (puntos, movimientos, direcciones, wishlist) y niveles |
| `crm.loyalty.adjust` | ajustes manuales de puntos con motivo |
| `crm.tiers.write` | crear, editar y borrar niveles (uno con clientes no se borra: `TIER_IN_USE`) |

- Cliente: `GET|POST /me/addresses`, `POST /me/addresses/geocode` (vista previa para el mapa), `GET|PATCH|DELETE
  /me/addresses/:id`, `PUT /me/addresses/:id/location`, `POST /me/addresses/:id/default`; `GET|POST /me/wishlist`,
  `PATCH|DELETE /me/wishlist/:productId`; `GET /me/loyalty`, `GET /me/loyalty/transactions`,
  `POST /me/loyalty/redemptions`; `GET /me/referral`, `POST /me/referral/apply`.
- Backoffice: `GET|POST /crm/loyalty/tiers`, `PATCH|DELETE /crm/loyalty/tiers/:id`, `GET /crm/customers/:userId/loyalty`
  (y `/transactions`), `POST /crm/customers/:userId/loyalty/adjustments`, `GET /crm/customers/:userId/addresses`,
  `GET /crm/customers/:userId/wishlist`.

## Reseñas y preguntas (`libs/modules/catalog`, `CatalogReviewsModule`)

Schema `catalog`, en un módulo aparte de `CatalogModule` porque necesita Pedidos (compra verificada) e IAM (nombre del
autor), y a `CatalogModule` lo importan Carrito, Checkout y Posventa. Migración `1759000000011_resenas-preguntas.js`:
`rejection_reason`, `moderated_by` y `moderated_at` en reseñas y preguntas (cambio aprobado el 2026-10-01) y una sola
reseña sin compra por cliente y producto.

- **Compra verificada:** la reseña se liga a una línea de un pedido ENTREGADO del cliente para ese producto
  (`OrdersApi.findDeliveredLines`). Una reseña por línea; sin compra, una por producto y sin el distintivo.
- **Fotos:** `POST /me/reviews/photos` (multipart `photo`, JPG/PNG/WEBP hasta 5 MB, se verifica la firma del archivo),
  hasta 5 por reseña, en SeaweedFS (`REVIEW_PHOTO_STORAGE`). Solo se sirven públicamente si la reseña está aprobada.
- **Moderación:** todo entra `pending`. La cola marca (no decide) emails, teléfonos, enlaces y lenguaje ofensivo.
  Aprobar o rechazar (con motivo) bloquea el producto y recalcula `rating_avg`/`rating_count` en la misma transacción.
  Eventos `ReviewSubmitted`, `ReviewApproved` y `ReviewRejected`.
- **Público:** resumen (promedio, distribución, cómo queda la talla, cuántas con fotos y verificadas), filtros por
  estrellas, con fotos o solo verificadas, y autor como "Ana P." (nunca el email).
- **Preguntas:** el cliente pregunta (queda pendiente); el staff la publica, la rechaza o la responde con una respuesta
  oficial, que la publica (`QuestionAnswered`). Por ahora solo hay respuestas oficiales.

| Permiso | Endpoints |
|---|---|
| — (público, `X-Tenant-Id`) | `GET /products/:id/reviews`, `GET /products/:id/reviews/:reviewId/photos/:n`, `GET /products/:id/questions` |
| cliente | `POST /products/:id/reviews`, `POST /products/:id/questions`, `GET /me/reviews`, `POST /me/reviews/photos` |
| `catalog.reviews.moderate` | `GET /catalog/reviews?status=`, `GET /catalog/reviews/:id/photos/:n`, `POST /catalog/reviews/:id/approve`, `POST /catalog/reviews/:id/reject` |
| `catalog.questions.answer` | `GET /catalog/questions?status=`, `POST /catalog/questions/:id/publish`, `.../reject`, `.../answers` |

### Cómo probar CRM y reseñas

```bash
npx jest -c jest.unit.config.js libs/modules/crm libs/modules/catalog
npx jest -c jest.int.config.js test/crm test/catalog   # Nominatim falso, puntos, referidos, reseñas y preguntas
```

A mano (después de `npm run migrate:up` y `seed:dev`; sin el perfil `maps`, deja `NOMINATIM_URL` vacío y usa el pin):

```bash
CLIENTE=$(npm run -s token:dev -- <tenantId> <customerId> --customer)
STAFF=$(npm run -s token:dev -- <tenantId> <userId>)
curl -X POST localhost:3000/v1/me/addresses -H "Authorization: Bearer $CLIENTE" -H 'content-type: application/json' \
  -d '{"recipientName":"Ana Pérez","recipientPhone":"0991234567","province":"Pichincha","city":"Quito",
       "mainStreet":"Av. Amazonas","houseNumber":"N34-120","crossStreet":"Naciones Unidas"}'      # mira geocode.status
curl -X PUT localhost:3000/v1/me/addresses/<id>/location -H "Authorization: Bearer $CLIENTE" \
  -H 'content-type: application/json' -d '{"lat":-0.1765,"lng":-78.48}'                          # pin manual
curl -X POST localhost:3000/v1/me/wishlist -H "Authorization: Bearer $CLIENTE" -H 'content-type: application/json' \
  -d '{"productId":"<productId>"}'
curl -H "Authorization: Bearer $CLIENTE" localhost:3000/v1/me/loyalty      # nivel y puntos pendientes tras una entrega
curl -H "Authorization: Bearer $CLIENTE" localhost:3000/v1/me/referral     # código para compartir
curl -X POST localhost:3000/v1/products/<productId>/reviews -H "Authorization: Bearer $CLIENTE" \
  -H 'content-type: application/json' -d '{"rating":5,"fitFeedback":"true","body":"Muy buena tela, talla exacta."}'
curl -H "Authorization: Bearer $STAFF" localhost:3000/v1/catalog/reviews   # cola con marcas
curl -X POST -H "Authorization: Bearer $STAFF" localhost:3000/v1/catalog/reviews/<reviewId>/approve
curl -H "X-Tenant-Id: <tenantId>" localhost:3000/v1/products/<productId>/reviews
```

## Módulo Soporte (`libs/modules/support`) — tickets, SLA y CSAT

Schema `support`: `tickets` y `ticket_messages`. Importa IAM (agentes y contacto), Pedidos y Logística (validar el
pedido y el envío vinculados); nadie lo importa. Los emails y alertas los envía Notificaciones al consumir los eventos
`Ticket*`; el consumidor `SupportConsumersModule` abre tickets por eventos de otros módulos y el job
`sweep-support-tickets` (cola `support`, `SupportWorkerModule`) es el reloj del SLA.

Cambios al modelo (migración `1759000000012_soporte.js`, aprobados el 2026-10-01), solo columnas nuevas en
`support.tickets`: `version` (concurrencia optimista), `updated_at`, `sla_breached_at` (la alerta sale una sola vez y
mide el cumplimiento), `closed_at`, `csat_comment` / `csat_at` y `source_ref` (con índice único parcial: un evento
repetido no abre dos tickets). Más un CHECK (CSAT solo con `closed_at`) e índices para el job y "mis tickets".

### Ciclo de vida

```
open ──▶ in_progress ◀──▶ pending_customer
  │          │                  │
  └──────────┴──▶ resolved ──▶ closed ──▶ encuesta CSAT (1 a 5, una vez)
                     └──▶ in_progress (el cliente responde o el agente reabre)
```

- **Vínculo:** `orderId` y `shipmentId` opcionales; el envío exige su pedido y se valida con `LogisticsApi.getShipments`.
  Un cliente solo vincula pedidos suyos (si no, 404).
- **Mensajes:** públicos (cliente y respuestas del agente) o internos (`is_internal`: notas y mensajes de sistema con
  cada asignación y cambio de estado, prioridad o categoría). El cliente nunca ve los internos.
- **Respuesta al cliente:** marca `first_response_at`, autoasigna a quien responde si no había agente y deja el ticket en
  `pending_customer` (o `in_progress` / `resolved`). Sale por email (`TicketReplied` → `ticket.reply`).
- **Cliente responde:** `pending_customer` o `resolved` vuelven a la cola (`in_progress` con agente, `open` sin agente).
  Un ticket cerrado no admite mensajes: se abre uno nuevo.
- **Asignación:** solo a un usuario `staff` activo cuyo rol tenga `support.tickets.write` (`IamApi.staffHasPermission`).
  Asignar un ticket `open` lo pasa a `in_progress`.

### SLA por prioridad

Tiempo de resolución en horas corridas desde la creación: urgente 4, alta 8, normal 24, baja 72
(`SUPPORT_SLA_*_HOURS`). Cambiar la prioridad lo recalcula desde la creación y, si el nuevo vencimiento es futuro,
rearma la alerta. El job (cada `SUPPORT_SWEEP_EVERY_MS`, 5 min) toma con `SKIP LOCKED` los tickets `open` /
`in_progress` vencidos y sin alertar, marca `sla_breached_at` y emite `TicketSlaBreached` (alerta ntfy al backoffice).
`pending_customer` no alerta (se espera al cliente); si el cliente responde tarde, la alerta sale en la siguiente pasada.
El mismo job cierra los `resolved` sin respuesta tras `SUPPORT_AUTO_CLOSE_DAYS` (3) y eso envía la encuesta.

### Invitados y enlace firmado

Un invitado abre un ticket con el **número y el email de su pedido** (`POST /support/guest-tickets` con `X-Tenant-Id`).
La respuesta no trae acceso: el enlace llega por email (prueba que el correo es suyo). Cada email de soporte lleva un
enlace firmado con HMAC (`/soporte/t/<token>`, vence a los `SUPPORT_LINK_TTL_DAYS`) con el que el cliente, invitado o
no, ve el ticket, responde y contesta la encuesta sin iniciar sesión. La encuesta del email trae un enlace por puntaje
(`…/encuesta?score=N`): la página del storefront confirma y hace el POST (un GET de un enlace no cambia datos).

### Tickets automáticos

`InvoiceRejected` (Facturación) abre un ticket interno (`channel internal`, `invoice`, prioridad alta) con la clave de
acceso y los mensajes del SRI. `source_ref = invoice:<documento>:<estado>`. Un ticket interno no tiene cliente: solo
admite notas.

### Permisos y endpoints (`/v1/...`)

| Método | Ruta | Permiso |
|---|---|---|
| POST / GET | `/me/tickets` | cliente |
| GET | `/me/tickets/:id` | cliente (sin notas internas) |
| POST | `/me/tickets/:id/messages` · `/me/tickets/:id/csat` | cliente |
| POST | `/support/guest-tickets` | público (header `X-Tenant-Id`) |
| GET · POST | `/support/ticket-links/:token` · `/messages` · `/csat` | enlace firmado |
| GET | `/support/tickets?status=open,in_progress&priority=urgent&assignedTo=me\|none\|<uuid>&overdue=true&orderId=…&number=…` | `support.tickets.read` |
| GET | `/support/tickets/:id` (con notas internas) | `support.tickets.read` |
| POST | `/support/tickets` (registrado por el agente: teléfono, WhatsApp…) | `support.tickets.write` |
| POST | `/support/tickets/:id/take` | `support.tickets.write` |
| PATCH | `/support/tickets/:id` `{ status?, priority?, category?, expectedVersion? }` | `support.tickets.write` |
| POST | `/support/tickets/:id/replies` `{ body, status? }` · `/notes` `{ body }` | `support.tickets.write` |
| PUT | `/support/tickets/:id/assignee` `{ agentId \| null }` | `support.tickets.assign` |

`expectedVersion` (opcional en take, assignee, PATCH y replies) devuelve 409 `STALE_VERSION` si otro agente cambió el
ticket después de que lo leíste.

### Cómo probar Soporte

```bash
cd backend
npx jest -c jest.unit.config.js libs/modules/support libs/modules/notifications
npx jest -c jest.int.config.js test/support-tickets      # Testcontainers: no toca tu base local
# Con la infraestructura del compose y la base migrada (npm run migrate:up):
npm run dev:api & npm run dev:worker
TOKEN=$(npm run -s token:dev -- <tenantId> <userId>)          # staff con los permisos de soporte
curl -s "localhost:3000/v1/support/tickets?overdue=true" -H "Authorization: Bearer $TOKEN"
CLIENTE=$(npm run -s token:dev -- <tenantId> <customerId> --customer)
curl -s localhost:3000/v1/me/tickets -H "Authorization: Bearer $CLIENTE" -H "Content-Type: application/json" \n  -d '{"category":"delivery","subject":"Mi pedido no llega","body":"Han pasado 3 días"}'
# Emails en Mailpit http://localhost:8025 · alertas de SLA en http://localhost:8090/moda-demo-backoffice
```

## Módulo Reportes (`libs/modules/reports`) — KPIs del gerente y exportes Excel/PDF

Schema `reports`. Es el único módulo que lee varios schemas, y solo a través de **vistas materializadas**: el
dashboard nunca consulta las tablas transaccionales, así que no compite con el checkout. No importa otros módulos ni
emite eventos. El worker (`ReportsWorkerModule`, cola `reports`) tiene dos jobs:

- `refresh-report-views` cada `REPORTS_REFRESH_EVERY_MS` (15 min): `REFRESH MATERIALIZED VIEW CONCURRENTLY` de cada
  vista. La versión anterior sigue disponible para lectura mientras se recalcula. Cada vista va en su propia
  transacción con un advisory lock (si dos workers coinciden, el segundo la salta) y `statement_timeout` de 10 min.
  `reports.refresh_log` guarda cuándo se refrescó; cada respuesta trae `dataAsOf`.
- `process-report-exports` cada `REPORTS_EXPORT_EVERY_MS` (5 s): toma los exportes pendientes con `SKIP LOCKED` y los
  genera de a uno.

Cambios al modelo (migración `1759000000013_reportes.js`): schema nuevo `reports`, sin tocar tablas existentes.

| Objeto | Grano | Para |
|---|---|---|
| `mv_sales_daily` | día × ciudad × barrio × método de pago × tipo de entrega × canal × courier × motorizado | ventas, pedidos, ticket promedio, margen |
| `mv_sales_items_daily` | día × categoría × talla × color × producto | unidades, ventas y margen por artículo |
| `mv_delivery_performance` | día (creación del envío) × tipo × courier × motorizado × zona | tiempos, cumplimiento, calificación |
| `mv_funnel_daily` | día | carritos, abandonos, pedidos, conversión |
| `export_jobs` (tabla) | un exporte | estado, parámetros congelados, clave en SeaweedFS, vencimiento |
| `refresh_log` (tabla) | una vista | último refresco y duración |

Definiciones, todas con días calendario en America/Guayaquil:

- **Venta**: un pedido no cancelado que está pagado, o que es contra entrega. Los no pagados y los cancelados
  cuentan solo en el embudo como "pedidos creados".
- **Ventas netas**: mercadería sin IVA (`line_total - tax_amount`), descontando las unidades devueltas. **Ventas
  brutas**: `orders.total` (con IVA y envío). **Ticket promedio** = ventas brutas / pedidos.
- **Margen** = ventas netas - costo (`unit_cost` × unidades conservadas), calculado solo con las líneas que tienen
  costo. El margen % usa la misma base, así una línea sin costo no lo infla.
- **Barrio**: `shipping_address.neighborhood`. El checkout lo guarda de la dirección del CRM (`addressId`) o del campo
  opcional `shippingAddress.neighborhood`. Sin barrio se usa la zona de cobertura, y si tampoco hay zona, «Sin barrio».
- **Tiempo de entrega**: del pago a la entrega. En contra entrega se cuenta desde la compra, porque su `paid_at` se
  fija al entregar. **A tiempo**: entregado antes del fin de la franja, del ETA o del SLA del servicio de courier,
  en ese orden. Se guardan sumas y tramos (hasta 2 h, 2 a 24 h, 24 a 48 h, más de 48 h), no percentiles, para que
  semana y mes se puedan reagregar sin volver a las tablas.
- **Conversión** = ventas / carritos con productos. No hay tracking de visitas, así que es conversión carrito→compra.
  **Abandonado**: un carrito activo con productos y 1 h o más sin actividad, que es la primera etapa del recordatorio.

Los días o semanas sin datos vuelven en cero en los reportes por tiempo. El `groupBy` se valida contra una lista
blanca y cada dimensión es una expresión SQL fija, así que nada del request se concatena en la consulta.

### Exportes Excel / PDF

`POST /v1/reports/exports` valida la consulta, la guarda en `export_jobs.params` y responde **202** con
`status: queued`. El worker la ejecuta y arma el archivo: **ExcelJS** genera una hoja con encabezado congelado,
autofiltro, montos como número con formato `$` y fila de totales; **pdfkit** genera un A4 apaisado con el encabezado
repetido en cada página y la numeración. El archivo se guarda en SeaweedFS (`reports/exports/<tenant>/<id>.xlsx|pdf`,
`REPORT_EXPORT_STORAGE=seaweedfs|memory`). La descarga lo lee de ahí y responde 409 `EXPORT_NOT_READY` mientras se
genera, o 409 `EXPORT_EXPIRED` pasados `REPORTS_EXPORT_TTL_DAYS`. Si falla (SeaweedFS caído, por ejemplo), vuelve a
`queued` hasta 3 intentos; un `running` abandonado por un worker caído se retoma a los 10 min. Tope de
`REPORTS_EXPORT_MAX_ROWS` filas por archivo.

### Permisos y endpoints (`/v1/...`)

Fechas `from` y `to` en formato `AAAA-MM-DD`, ambas incluidas. Sin fechas: los últimos 30 días. Máximo 2 años.

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/reports/kpis?from&to` (período actual y anterior del mismo largo) | `reports.sales.read` + `reports.funnel.read` + `reports.delivery.read` |
| GET | `/reports/sales?groupBy=day\|week\|month\|city\|neighborhood\|payment_method\|fulfillment_type\|channel\|courier\|rider` | `reports.sales.read` |
| GET | `/reports/sales/items?groupBy=category\|size\|color\|product&limit=50` | `reports.sales.read` |
| GET | `/reports/delivery?groupBy=day\|week\|month\|carrier_type\|courier\|rider\|zone` | `reports.delivery.read` |
| GET | `/reports/funnel?groupBy=day\|week\|month` | `reports.funnel.read` |
| POST | `/reports/exports` `{ report: sales\|sales_items\|delivery\|funnel, format: xlsx\|pdf, groupBy?, from?, to? }` | `reports.export` + lectura del reporte |
| GET | `/reports/exports` (los míos) · `/reports/exports/:id` · `/reports/exports/:id/download` | `reports.export` |

### Cómo probar Reportes

```bash
cd backend
npx jest -c jest.unit.config.js libs/modules/reports
npx jest -c jest.int.config.js test/reports              # Testcontainers: no toca tu base local
# Con la infraestructura del compose y la base migrada (npm run migrate:up):
npm run dev:api & npm run dev:worker                       # el worker refresca las vistas al arrancar y cada 15 min
TOKEN=$(npm run -s token:dev -- <tenantId> <userId>)        # staff con los permisos reports.*
curl -s "localhost:3000/v1/reports/kpis" -H "Authorization: Bearer $TOKEN"
curl -s "localhost:3000/v1/reports/sales?groupBy=week&from=2026-09-01&to=2026-09-30" -H "Authorization: Bearer $TOKEN"
ID=$(curl -s localhost:3000/v1/reports/exports -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"report":"delivery","format":"xlsx","groupBy":"rider"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
sleep 6 && curl -s -o entregas.xlsx "localhost:3000/v1/reports/exports/$ID/download" -H "Authorization: Bearer $TOKEN"
```

## Catálogo público y tracking en vivo (para el storefront)

### Catálogo público — orquestador `libs/modules/storefront`

Lectura del schema `catalog` en `CatalogStorefrontApi` (Catálogo) + disponibilidad de Inventario, juntadas en
un módulo orquestador sin schema que nadie importa (como Checkout): Catálogo **no** importa Inventario (lo
contrario sí), así no hay ciclos de imports. Todo `@Public()` con `X-Tenant-Id` y `Cache-Control: public, max-age=60`.
Solo se ve lo publicado: `status='active'`, sin borrar, `published_at` vencido o nulo, categoría activa y al menos
una variante activa.

| Endpoint | Qué hace |
|---|---|
| `GET /v1/catalog/products` | Listado: `category` (incluye subcategorías), `collection`, `gender`, `brand`, `color`, `size` (listas por coma), `minPrice`, `maxPrice`, `onSale`, `q`, `sort` (`relevance`, `newest`, `price_asc`, `price_desc`, `rating`), `page`, `pageSize` ≤ 48. Talla, color y precio se evalúan sobre la **misma variante**; la tarjeta muestra el precio de la variante más barata que cumple. Devuelve `facets` **disyuntivas** (cada faceta cuenta ignorando su propio filtro) y `available` por tarjeta |
| `GET /v1/catalog/products/:slug` | Ficha: galería por color, variantes con `stock` `in_stock`/`low` (≤ 3)/`out_of_stock` (nunca la cantidad), guía de tallas (`size_charts.data`: `{ unit, columns, rows, howToMeasure }`), migas y relacionados |
| `GET /v1/catalog/search/suggest?q=` | Sugerencias: 6 productos, 3 categorías, 3 marcas |
| `GET /v1/catalog/categories` · `/brands` · `/collections` · `/sitemap` | Navegación y SEO (conteo de productos publicados) |
| `GET /v1/catalog/product-thumbs?ids=` | Foto y slug de hasta 50 productos (las líneas de carrito, wishlist y pedidos no los guardan) |

Búsqueda: `websearch_to_tsquery('spanish')` sobre `search_vector` + `ILIKE` en nombre y marca (comodines escapados)
+ `word_similarity` ≥ 0,5 de pg_trgm para errores de tipeo; relevancia = `ts_rank + word_similarity`.
Fotos: `product_media.storage_key` relativo se sirve bajo `CATALOG_MEDIA_BASE_URL` (por defecto `/media`).

### Tracking del motorizado (Logística, `application/tracking.service.ts`)

| Endpoint | Quién | Qué hace |
|---|---|---|
| `POST /v1/logistics/shipments/:id/assign` `{ riderId }` | staff `logistics.dispatch` (admin, bodega; migración 0016) | Asigna o reasigna antes del retiro. Contra entrega: 409 `RIDER_COD_LIMIT` si supera el tope de efectivo |
| `GET /v1/rider/shipments` · `GET /v1/rider/shipments/:id` | motorizado | Sus envíos activos (o uno suyo en cualquier estado) como `RiderShipment` (ver "App del motorizado") |
| `POST /v1/rider/shipments/:id/status` `{ status: picked_up|in_transit|arriving|failed_attempt, lat?, lng?, reason? }` | motorizado | Sin saltar estados (409 `SHIPMENT_INVALID_TRANSITION`). Al retirar se fija el código de entrega; `failed_attempt` suma `attempts` y vuelve con `in_transit` |
| `POST /v1/rider/shipments/:id/deliver` (multipart) | motorizado | Foto + firma + código, a ≤ 300 m del destino (422 `DELIVERY_TOO_FAR`); ver "App del motorizado" |
| `POST /v1/rider/location` | motorizado | GPS cada pocos segundos → `rider_location_history` (particionada; job diario de particiones) y, si lleva paquete, `rider.location` con ETA (OSRM o línea recta a 22 km/h). Devuelve `{ recorded, liveShipments, openOffers }` |
| `GET /v1/tracking/:token` | público (token) | Estado, eventos, destino sin referencia ni contacto, bodega, motorizado (vehículo, placa, rating), posición en vivo y `deliveryCode` (mientras va en camino) |
| `GET /v1/me/orders/:orderId/shipments` | cliente | Envíos de su pedido con su `trackingToken` y `deliveryCode` |

Cada estado avanza el pedido en la misma transacción (asignado → `preparing`, retirado → `shipped`, en camino →
`in_transit`, entregado → `delivered`; Pagos captura el contra entrega con `OrderDelivered`) y emite
`ShipmentStatusChanged` por el outbox (Notificaciones avisa por email/push). El checkout devuelve `delivery.trackingToken`.

### Tiempo real (`apps/realtime`, ADR-07)

NestJS + Socket.IO con `@socket.io/redis-adapter` en `REALTIME_PORT` (3002), ruta `/ws/socket.io` (Caddy: `/ws/*`).
El cliente se conecta con `auth: { trackingToken }` y queda en la sala `order:{id}`; un token inválido recibe
`tracking.error`. Solo lectura: los eventos (`rider.location`, `shipment.status`) los publican la API y el worker
con `RealtimePublisher` (shared kernel, `@socket.io/redis-emitter` sobre Valkey; `REALTIME_TRANSPORT=memory` en tests).
Es mejor esfuerzo: el estado durable está en PostgreSQL y el cliente lo relee por HTTP.

### Logística: tiempo real para el backoffice

| Endpoint | Permiso | Qué hace |
|---|---|---|
| `GET /v1/logistics/riders/live` | `logistics.read` | Motorizados no inactivos: nombre y teléfono (por `IamApi`), vehículo, presencia, efectivo, rating, última posición de las últimas 24 h (LATERAL sobre `ix_rlh`) y envíos en curso con su destino |
| `GET /v1/logistics/shipments?status=pending,ready_for_pickup&carrierType=&zoneId=&riderId=&limit=50&offset=0` | `logistics.read` | Cola de despacho `{ items, total }`, lo más antiguo primero |
| `POST /v1/rider/presence` `{ presence: offline|available|busy|break }` | motorizado | Fija su presencia y avisa al mapa |

Socket.IO del staff: **namespace `/staff`**, misma ruta `/ws/socket.io`, con el JWT de acceso de la API:
`io('/staff', { path: '/ws/socket.io', auth: { accessToken } })` (`apps/realtime/staff.gateway.ts`). Se verifica
con el mismo secreto, HS256, `iss`/`aud` que el `JwtAuthGuard`; exige `typ` staff y `logistics.read`. Queda en la
sala `riders:{tenantId}` y recibe `staff.ready`; si no, `staff.error` `{ code: UNAUTHORIZED|FORBIDDEN }` y desconexión.
Eventos: `rider.location` `{ riderId, lat, lng, heading, speedKmh, recordedAt, shipmentId }` (cada `POST /rider/location`),
`shipment.status` `{ shipmentId, orderId, riderId, status }` (asignación y estados del motorizado) y `rider.presence`
`{ riderId, presence, changedAt }`. Al vencer el token (15 min) el servidor emite `staff.error` `{ code: 'TOKEN_EXPIRED' }`
y desconecta: el cliente renueva con `POST /v1/auth/refresh`, pone `socket.auth = { accessToken }`, llama
`socket.connect()` y vuelve a pedir `GET /v1/logistics/riders/live` (los eventos perdidos no se reenvían).
Despacho automático: `dispatch.offer` `{ shipmentId, riderId, offerId, status: offered|accepted|rejected|expired|cancelled }`.

### App del motorizado: turnos, despacho automático y prueba de entrega

Servicios `application/rider-app.service.ts` (perfil, turnos, ganancias), `application/dispatch.service.ts`
(ofertas) y `application/tracking.service.ts` (entrega). Reglas puras en `domain/dispatch.ts`, `domain/shift.ts`,
`domain/delivery-proof.ts` y `domain/earnings.ts`. Migración `1759000000018`: solo índices (una oferta abierta por
envío, un turno activo por motorizado, vencimiento de ofertas y conteo de códigos fallidos).

| Endpoint (todos `/v1`, JWT de motorizado salvo indicación) | Qué hace |
|---|---|
| `GET /rider/me` | `{ riderId, userId, name, email, vehicleType, plate, status, presence, ratingAvg, ratingCount, codBalance, codLimit, codAvailable, maxConcurrent, ntfy: { url, topic }, shift }`. `topic` = `riders.ntfy_topic` (`rider-` + 24 caracteres base64url, se crea la primera vez); `url` = `NTFY_PUBLIC_URL` |
| `POST /rider/shift/start` `{ lat?, lng? }` → 201 | Activa el turno programado que cubre ahora o crea uno a demanda de `RIDER_SHIFT_DEFAULT_HOURS` (8) en su zona; presencia `available`. 409 `SHIFT_ALREADY_ACTIVE` |
| `POST /rider/shift/end` | `{ shift, summary: { deliveries, fees, codCollected } }`; presencia `offline`, cancela sus ofertas abiertas y las ofrece a otros. 409 `SHIFT_HAS_ACTIVE_SHIPMENTS` (asignado → intento fallido) / `NO_ACTIVE_SHIFT` |
| `GET /rider/offers` | Ofertas abiertas: `{ id, shipmentId, offeredAt, expiresAt, pickup, dropoff: { label, location }, distanceM, estimatedFee, codAmount, slot }`, sin datos de contacto |
| `POST /rider/offers/:id/accept` | El envío pasa a `accepted` (pedido → `preparing`) con la fila bloqueada; devuelve `RiderShipment`. 409 `OFFER_EXPIRED` / `OFFER_CLOSED`; la oferta de otro: 404 |
| `POST /rider/offers/:id/reject` `{ reason? }` → 204 | Y se ofrece de inmediato al siguiente |
| `POST /rider/shipments/:id/deliver` (multipart) | Campos `lat`, `lng`, `receiverName`, `otp` (4 dígitos; obligatorio si el envío lo tiene), `codCollected` (= `cod_amount` exacto o 422 `COD_AMOUNT_MISMATCH`), `codMethod` (`cash` por defecto, `card_pos`, `deuna_qr`: solo `cash` suma a `cod_balance`); archivos `photo` (JPG/PNG ≤ 5 MB, 422 `PROOF_PHOTO_REQUIRED`) y `signature` (PNG ≤ 1 MB, 422 `PROOF_SIGNATURE_REQUIRED`), tipo por magic bytes. Guarda en `DELIVERY_PROOF_STORAGE` (`logistics/proofs/<envío>/<uuid>.<ext>`) y filas `photo`, `signature` y `otp` en `delivery_proofs` |
| `GET /rider/earnings?from=AAAA-MM-DD&to=AAAA-MM-DD` | Por defecto, del lunes de esta semana a hoy (America/Guayaquil); máx. 62 días (422 `EARNINGS_RANGE_TOO_LONG`). Comisiones con su `commission_scheme`, `bonusEstimate`, efectivo por método, `today`, `byDay` e `items` (100, lo más nuevo primero) |
| `POST /logistics/shipments/:id/dispatch` (staff `logistics.dispatch`, auditado) | Ofrece ya al mejor motorizado: `{ offerId, riderId, expiresAt }` o 409 `NO_RIDER_AVAILABLE` |
| `GET /logistics/shipments/:id/proofs` (staff `logistics.read`) | `[{ id, proofType, receiverName, otpVerified, distanceToDestinationM, capturedAt, fileUrl }]` |
| `GET /logistics/proofs/:id/file` (staff `logistics.read`, auditado) | La foto o firma, `inline` con `X-Content-Type-Options: nosniff` |

`RiderShipment` = `{ id, orderId, orderNumber, status, pickup: { name, location }, destination: { ...dirección,
label, location, recipientName, phone, reference }, slot, codAmount, distanceM, estimatedFee, requiresOtp, attempts,
deliveredAt }` (el contacto sale de la dirección o, si no está, del cliente del pedido).

| Tema | Decisión |
|---|---|
| Disparo | `ShipmentStatusChanged` a `ready_for_pickup` de un despacho con motorizado (fulfillment terminó el picking) → consumidor `logistics.dispatch` del outbox. El job `logistics-dispatch` del worker (cada `DISPATCH_SWEEP_EVERY_MS`, 15 s) vence ofertas y reintenta los envíos listos sin oferta. Si nadie puede, queda para la asignación manual (que cancela la oferta abierta). |
| Candidatos | Mismo tenant, activo, turno activo, presencia `available` (o `busy`) bajo `max_concurrent`, efectivo disponible ≥ contra entrega, posición de los últimos 15 min, sin otra oferta abierta y sin haber recibido antes ese envío. |
| Puntaje | 0–100 (`score` + `score_breakdown`): 70 por cercanía a la bodega (lineal hasta 10 km), 20 por calificación, 10 por carga libre. Vence a los `DISPATCH_OFFER_TTL_SECONDS` (45). |
| Aviso | `RiderOfferNotifier` → ntfy (`POST NTFY_URL` en JSON, `NTFY_TOKEN`) o memoria (`RIDER_OFFER_TRANSPORT`, por defecto `NOTIFICATION_TRANSPORT`), después del commit: `{ title: 'Nueva oferta de entrega', message: 'Tienes 45 s para aceptarla', tags: ['motor_scooter'], priority: 5, click: 'modarider://ofertas' }`, **sin datos del cliente** (los tópicos de ntfy son públicos). Si ntfy falla, la app ve `openOffers` en cada `POST /rider/location`. |
| Código de entrega | `HMAC-SHA256(DELIVERY_OTP_SECRET, envío)` → 4 dígitos: el servidor lo muestra al cliente (`deliveryCode`) sin guardarlo; al retirar queda `otp_hash` = SHA-256. 5 códigos incorrectos en 15 min (filas `otp` con `otp_verified = false`, confirmadas antes del 422 `OTP_INVALID { attemptsLeft }`) → 423 `OTP_LOCKED`. |

Prueba manual con curl (API en `localhost:3000`; `$R` = token del motorizado `moto@demo.test` / `Demo-2026-segura`
por `POST /v1/auth/login` o `npm run -s token:dev -- $T <riderUserId> --rider`; `$S` = token de staff con
`logistics.dispatch`; `$T` = tenant):

```bash
curl -s -H "Authorization: Bearer $R" localhost:3000/v1/rider/me
curl -s -X POST -H "Authorization: Bearer $R" -H 'Content-Type: application/json' -d '{"lat":-0.15,"lng":-78.485}' localhost:3000/v1/rider/shift/start
# Un pedido con motorizado pagado y con picking terminado se ofrece solo; o a mano:
curl -s -X POST -H "Authorization: Bearer $S" localhost:3000/v1/logistics/shipments/$ENVIO/dispatch
curl -s -H "Authorization: Bearer $R" localhost:3000/v1/rider/offers          # la notificación llega a http://localhost:8090/<topic>
curl -s -X POST -H "Authorization: Bearer $R" localhost:3000/v1/rider/offers/$OFERTA/accept
curl -s -X POST -H "Authorization: Bearer $R" -H 'Content-Type: application/json' -d '{"status":"picked_up"}' localhost:3000/v1/rider/shipments/$ENVIO/status
curl -s -H "X-Tenant-Id: $T" localhost:3000/v1/tracking/$TOKEN | jq .deliveryCode   # el código que dicta el cliente
curl -s -X POST -H "Authorization: Bearer $R" -H 'Content-Type: application/json' -d '{"status":"in_transit"}' localhost:3000/v1/rider/shipments/$ENVIO/status
curl -s -X POST -H "Authorization: Bearer $R" -F lat=-0.1765 -F lng=-78.4844 -F receiverName='Lucía Torres' -F otp=$CODIGO \
     -F photo=@entrega.jpg -F signature=@firma.png localhost:3000/v1/rider/shipments/$ENVIO/deliver
curl -s -X POST -H "Authorization: Bearer $R" localhost:3000/v1/rider/shift/end
curl -s -H "Authorization: Bearer $R" "localhost:3000/v1/rider/earnings?from=2026-10-01&to=2026-10-31"
npx jest -c jest.int.config.js test/logistics/rider-app.int-spec.ts
```

### Cómo probarlo

```bash
npm run seed:dev            # también siembra el catálogo de demo (scripts/seed-catalog.ts)
npm run dev:api; npm run dev:worker; npm run dev:realtime
curl -H "X-Tenant-Id: $T" "localhost:3000/v1/catalog/products?category=mujer&size=M&color=Negro&sort=price_asc"
# Compra con motorizado en el storefront (o por la API) y después:
npm run sim:rider -- <número de pedido>   # asigna al motorizado de demo, retira, lo lleva al destino y entrega con foto, firma y código
npx jest -c jest.int.config.js test/catalog/storefront.int-spec.ts test/logistics/tracking.int-spec.ts test/logistics/live.int-spec.ts test/logistics/rider-app.int-spec.ts
```

## Seguridad (OWASP Top 10) y privacidad (LOPDP)

Detalle, matriz OWASP, riesgos residuales y checklist de producción en `docs/07-seguridad.md`.

- **Borde HTTP** (`configureApp` → `libs/shared-kernel/security/http-hardening.ts`):
  - helmet con CSP `default-src 'none'`, CORS por lista blanca (`CORS_ORIGINS`).
  - `trust proxy` (`TRUST_PROXY`), cuerpo de 100 kB como máximo y `X-Request-Id`.
- **Rate limiting** con Valkey (`security/rate-limit.ts`):
  - Perfil global de 120/min por IP.
  - `@RateLimit('auth' | 'checkout' | 'lookup')` en login/2FA, checkout/pagos y búsquedas por código.
  - Responde 429 con `Retry-After`.
- **Auditoría automática:** `@Audited('modulo.cosa.verbo', { entity })` escribe en `platform.audit_log`.
  - Guarda actor, IP, request id, cuerpo redactado y resultado.
  - `audit_log` es de solo inserción (trigger de la migración 0015).
- **Cifrado de campos `*_enc`:** `FieldCipher` (libsodium `crypto_secretbox`, `DATA_ENCRYPTION_KEY`, con rotación).
  Las claves de Web Push quedan en `push_subscriptions.keys_enc`.
- **Validación:** todos los DTOs con cotas. `test/platform/dto-coverage.int-spec.ts` falla si una ruta recibe
  entradas sin DTO o pipe.
- **LOPDP** (`libs/modules/privacy`):
  - `GET /v1/me/privacy/export` (JSON con todos mis datos).
  - `POST /v1/me/privacy/anonymize` (`{ password, confirm: "ELIMINAR MI CUENTA" }`).
  - Cada módulo registra su parte en el `PersonalDataRegistry`.
- **Herramientas** (en contenedores desechables): `npm run sec:semgrep`, `npm run sec:trivy`, `npm run sec:zap`.

## Observabilidad (OpenTelemetry → Grafana LGTM, Uptime Kuma)

La API y el worker envían **trazas, métricas y logs** por OTLP/HTTP a `grafana/otel-lgtm`
(perfil `obs`: Grafana, Prometheus, Loki y Tempo en una sola imagen).

| Pieza | Dónde | Qué hace |
|---|---|---|
| SDK | `libs/shared-kernel/observability/telemetry.ts`, cargado por `apps/{api,worker}/instrumentation.ts` (**primer import** de cada `main.ts`) | Auto-instrumentación de http, express, Nest, pg, ioredis y undici. `service.name` = `moda-api` / `moda-worker`. Sin `OTEL_EXPORTER_OTLP_ENDPOINT` (o con `OTEL_SDK_DISABLED=true`) no arranca: los tests y los scripts no exportan nada. `/v1/health` no se traza. Los spans de pg no llevan parámetros (pueden tener datos personales). |
| Logs JSON | `JsonLogger` (`LOG_FORMAT=json`, por defecto; `pretty` = el de Nest) | Una línea JSON por evento en stdout con `level`, `service`, `context`, `msg`, `request_id`, `tenant_id`, `user_id`, `trace_id` y `span_id`. También va a Loki por OTLP. `logger.log({ msg, ...campos })` agrega campos. |
| `request_id` | `requestIdMiddleware` (ya existía) + `AsyncLocalStorage` (`request-context.ts`) | El `X-Request-Id` de Caddy (o uno nuevo) acompaña a todos los logs del request y queda como atributo `request_id` del span HTTP. El mismo id está en `platform.audit_log`. |
| Log de acceso | `httpAccessLogMiddleware` | `POST /v1/checkout 201 84.2ms` con método, **ruta plantilla** (nunca la URL real: puede llevar tokens o ids), status y duración. 5xx con nivel error. El `/v1/health` exitoso no se registra. |
| Latencia y errores | `http.server.request.duration` (estándar de OTel) | Histograma por `http_route`, método y status → p95 por endpoint y tasa de 5xx. |
| Colas | `QueueMetrics` (worker) | `bullmq_queue_jobs{queue,state}`. Las colas se **descubren** en Valkey (`bull:*:meta`): una cola nueva aparece sola. |
| Pedidos | contador en `OutboxRelay` | `outbox_events_published_total{event_type}` (y `outbox_events_failed_total`). Pedidos por minuto = `event_type="OrderPlaced"`. |
| Facturación | `BillingMetrics` (worker, schema `billing`) | `sri_documents_pending{status,doc_type}` (pending, signed, sent, received), `sri_documents_pending_oldest_age_seconds` y `sri_documents_rejected` (24 h). |

**Grafana** (`infra/observability/grafana`, montado en el contenedor `lgtm`):

- Dashboard **Moda · Operación**, en la carpeta Moda. Paneles: p95 por endpoint, errores 5xx y 4xx, requests, logs
  de error (de Loki a Tempo con un clic), jobs en espera, activos y fallidos por cola, pedidos por minuto, eventos de
  dominio, facturas pendientes del SRI, el pendiente más viejo y los rechazados.
  - Se edita en `build-dashboard.mjs`; se regenera con `node infra/observability/grafana/build-dashboard.mjs`.
- **Alertas** (`provisioning/alerting/moda.yaml`), todas a **ntfy** (tópico `NTFY_OPS_TOPIC`, con la plantilla
  `grafana` de ntfy):

  | Alerta | Condición |
  |---|---|
  | API: latencia p95 alta | > 1 s durante 5 min |
  | API: tasa de errores 5xx | > 5 % durante 5 min (con tráfico mínimo) |
  | API sin telemetría / Worker sin telemetría | sin métricas por 3 min |
  | Cola atascada | > 100 jobs en espera por 10 min |
  | Jobs fallidos | suben en 15 min |
  | Outbox: consumidores fallando | algún intento fallido en 15 min |
  | SRI: comprobantes atascados | pendiente más viejo > 30 min |

**Uptime Kuma** (http://localhost:3002):

- `kuma-setup` (`infra/observability/uptime-kuma/setup.mjs`, por el socket.io de Kuma 1.x) crea el admin, la
  notificación a ntfy y dos monitores cada 60 s:
  - `http://api:3000/v1/health`, la API directa.
  - `http://waf:8080/api/v1/health`, la ruta pública WAF → Caddy → API.
- Es idempotente: se puede volver a correr.

### Cómo probarlo

```bash
# Tests (el SDK queda apagado; las métricas se leen con un MeterProvider en memoria)
npx jest -c jest.unit.config.js libs/shared-kernel/observability
npx jest -c jest.int.config.js test/platform/observability

# Todo en Docker (en ./.env: NTFY_OPS_TOPIC, GRAFANA_ADMIN_PASSWORD, KUMA_ADMIN_PASSWORD)
docker compose --profile obs up -d
docker compose --profile obs run --rm kuma-setup
# Grafana  http://localhost:3001  → Dashboards → Moda → Moda · Operación   (Explore → Loki: {service_name="moda-api"} | request_id="<X-Request-Id>")
# Alertas  http://localhost:8090/<NTFY_OPS_TOPIC>   ·   Uptime Kuma  http://localhost:3002

# API y worker fuera de Docker, con solo lgtm en Docker
docker compose --profile obs up -d lgtm
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npm run dev:api     # y npm run dev:worker
curl -i localhost:3000/v1/me/orders -H 'X-Request-Id: prueba-observabilidad-1'   # 401: búscalo en Loki por ese request_id
```

## Pendiente

- **Facturación, siguiente paso:** anulación (`voided`), reemisión de una factura `returned` o `not_authorized` corregida desde el backoffice, y reenvío manual del
  email. Probar contra el ambiente real de pruebas del SRI (celcer) requiere RUC y una firma `.p12` acreditada.
- **Reembolsos fuera de devoluciones:** una aprobación que llega después de vencer o cancelar el pago queda como
  `late_approval` en la bitácora, igual que un pedido pagado que se cancela: falta el caso de uso de reembolso sin
  devolución (`RefundService` ya soporta la aprobación y la ejecución).
- **Devoluciones, siguiente paso:** guardar el motivo del rechazo (hoy solo va en el evento `ReturnRejected`) y los
  datos bancarios del cliente para la transferencia, que no tienen columna; devolver al cliente un paquete que la
  inspección rechaza; convertir en reembolso un cambio sin stock; notas de crédito cuando la factura fue a consumidor
  final (habría que identificar al comprador en la solicitud); guía del courier para el retiro (hoy el envío nace
  `pending`, como los del checkout, y sigue el mismo despacho pendiente).
- **Reposición de stock** al cancelar un pedido cuya reserva ya se consumió (pagado o en preparación): Inventario lo
  registra como advertencia; falta la operación en `InventoryApi`.
- **Logística, siguiente paso:** despacho automático (ofertas a motorizados, `dispatch_offers`; hoy se asigna a mano), OTP o foto en la prueba de entrega, guía del courier con
  `CourierPort.createShipment`/`getLabel` guardada en SeaweedFS, **receptor de webhooks del courier**
  (`POST /v1/webhooks/couriers/simulator`, firma `X-Couriersim-Signature`; deduplicación con
  `UNIQUE (shipment_id, status, occurred_at)` de `shipment_events`). El despacho automático no debe ofrecer pedidos contra
  entrega a un motorizado sin tope disponible (la asignación manual ya lo valida con `codControl`). Posición actual en Valkey GEO
  para elegir al más cercano (hoy solo el histórico).
- **CRUD de motorizados** (alta, turnos, `commission_scheme`, `cod_limit`): hoy se crean con SQL o con `seed:dev`.
- **CRM, siguiente paso:** plantillas de Notificaciones para los eventos del CRM y de reseñas (`Wishlist*`, `Loyalty*`,
  `Referral*`, `Review*`, `QuestionAnswered`), vencimiento de puntos (movimiento `expire`), votos de "útil" en reseñas
  (no hay tabla de votos), respuestas de compradores en preguntas (`product_answers` no tiene estado de moderación) y
  geocodificación inversa de Nominatim para completar barrio y parroquia desde el pin.
- **Backoffice** (Next.js): cola de verificación de transferencias, asignación de motorizados y moderación. El storefront ya existe (`storefront/`).
- **Puntos de retiro públicos**: no hay endpoint para listar bodegas `is_pickup_point` sin permiso; el checkout del storefront no ofrece retiro en tienda.
- **IAM (mejoras fuera de la entrega):** verificación de email, recuperación de contraseña, códigos de recuperación del
  2FA (no hay tabla), fusión del carrito de invitado al iniciar sesión (`CartApi.mergeGuestCart`), OAuth
  (`iam.user_identities`), clientes de API (`iam.api_clients`) y CRUD de productos de Catálogo (`catalog.product.write`).
- **Vencimiento de gift cards** (movimiento `expire`).
- **Notificaciones, siguiente paso:** avisos de devoluciones y reembolsos (`Return*`, `Refund*`), alerta al motorizado
  por ntfy al asignarle un envío (cuando exista el despacho), `StockBelowThreshold` al backoffice, consentimiento de
  invitados en el checkout (hoy `iam.consents` no tiene `tenant_id`: el de un invitado vale para su email en cualquier
  tenant) y estados `delivered`/`read` (requieren webhooks del proveedor; los simuladores no los envían).
- **Soporte, siguiente paso:** adjuntos en los mensajes (`ticket_messages.attachments` existe; faltaría la subida a
  SeaweedFS como las fotos de devoluciones), respuestas por email entrante (Mailpit no recibe correo: hoy el cliente
  responde por el enlace), SLA en horario laboral y pausa del SLA en `pending_customer` (hoy no alerta, pero el reloj
  sigue), aviso al agente al asignarle un ticket y alerta por CSAT bajo.
- **Reportes, siguiente paso:** refresco incremental (hoy cada refresco recalcula todo el historial; con mucho volumen
  convendría particionar por mes y recalcular solo los días recientes), tracking de visitas para la conversión
  visita→compra, borrado de los archivos vencidos en SeaweedFS (el puerto ObjectStorage no tiene delete) y aviso por
  Notificaciones cuando un exporte termina.
- **dependency-cruiser en CI:** verificar que ningún módulo importe internos de otro.
- **Limpieza de `platform.idempotency_keys`** vencidas (job diario con `ix_idem_expiry`).
