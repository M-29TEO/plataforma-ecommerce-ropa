# Entregable 1 — Arquitectura de alto nivel (C4)

> Versión revisada: stack 100 % open source y sin costo. Los servicios comerciales se reemplazan por simuladores detrás de puertos.

## 1.0 Decisiones arquitectónicas base (ADR resumidos)

| # | Decisión | Elección | Motivo |
|---|---|---|---|
| ADR-01 | Estilo arquitectónico | **Monolito modular** con arquitectura hexagonal por módulo | Con 2-3 devs y 8-12 semanas, los microservicios multiplican el costo operativo. Los límites estrictos entre módulos permiten extraer servicios después sin reescribir. |
| ADR-02 | Lenguaje | **TypeScript end-to-end** | Un solo lenguaje para storefront, backoffice, app de motorizado y backend. Mucho talento disponible en LATAM. |
| ADR-03 | Framework backend | **NestJS** | Módulos, inyección de dependencias, guards, colas y WebSockets. Encaja con un monolito modular. |
| ADR-04 | Base de datos | **PostgreSQL 16 + PostGIS**, un *schema* por módulo | ACID para stock, pedidos y pagos. PostGIS para zonas de cobertura y cercanía. `jsonb` donde hace falta flexibilidad. |
| ADR-05 | Comunicación entre módulos | Síncrona mediante la **API pública del módulo**. Asíncrona mediante **eventos de dominio con Transactional Outbox** | Evita joins entre módulos y garantiza que ningún evento se pierda. |
| ADR-06 | Procesamiento asíncrono | **Worker** (mismo código, otro proceso) con **BullMQ sobre Valkey** | Aísla integraciones lentas (SRI, couriers, notificaciones) del checkout. Reintentos, backoff, trabajos diferidos y cron nativos. |
| ADR-07 | Tiempo real | Gateway **Socket.IO con adaptador Valkey** | Tracking en vivo y estados del pedido. Primer candidato a extraerse como servicio. |
| ADR-08 | Infraestructura | **Docker Compose self-hosted** (opcional k3s) | Restricción del proyecto: open source y sin costo. |
| ADR-09 | Multi-tenant | `tenant_id` en agregados raíz + **Row Level Security** activable | Costo casi nulo hoy; habilita futuras marcas sin migración. |
| ADR-10 | Servicios externos | **Simuladores** (pagos, SRI, couriers) con webhooks firmados HMAC | No existen equivalentes open source; demuestra la arquitectura hexagonal. |

## 1.1 Nivel 1 — Diagrama de contexto

```mermaid
flowchart TB
    cliente["Cliente<br/>Web · PWA · App móvil"]
    staff["Personal interno<br/>Admin · Gerente · Vendedor<br/>Bodega · Soporte"]
    moto["Motorizado<br/>App móvil"]

    plat[["PLATAFORMA MODA E-COMMERCE<br/>Catálogo · Carrito · Pedidos · Pagos<br/>Logística · Facturación · Reportes"]]

    pagos["Pasarelas de pago<br/>Datafast · Payphone · Medianet<br/>DeUna · Banco Pichincha<br/>(simuladas en el proyecto)"]
    sri["SRI Ecuador<br/>Comprobantes electrónicos<br/>(simulado / ambiente de pruebas)"]
    couriers["Couriers externos<br/>Servientrega · otros<br/>(simulados)"]
    mapas["OpenStreetMap<br/>Nominatim · OSRM · MapLibre"]
    msg["Notificaciones<br/>Email · Web Push · ntfy<br/>(WhatsApp/SMS simulados)"]

    cliente -->|Compra, paga, rastrea, reseña| plat
    staff -->|Gestiona catálogo, stock, pedidos,<br/>tickets, reportes| plat
    moto -->|Recibe asignaciones, reporta GPS,<br/>prueba de entrega| plat

    plat -->|Cobros, reembolsos| pagos
    pagos -.->|Webhooks firmados| plat
    plat -->|XML firmado de facturas y NC| sri
    plat -->|Cotiza, genera guía, consulta tracking| couriers
    couriers -.->|Webhooks o polling de estados| plat
    plat -->|Geocoding, rutas, distancias| mapas
    plat -->|Notificaciones transaccionales<br/>y de marketing| msg
```

- **Actores humanos:** 7 roles con permisos distintos sobre la misma plataforma. El courier externo (rol 8) se integra como sistema.
- **Críticas para el checkout:** pagos y mapas.
- **No bloquean el checkout:** SRI, couriers y notificaciones (asíncronos con reintentos). Si el SRI no responde, la venta se concreta y la factura se autoriza después.

## 1.2 Nivel 2 — Diagrama de contenedores

```mermaid
flowchart TB
    subgraph CLIENTES["Aplicaciones cliente"]
        web["Storefront Web + PWA<br/>Next.js · MapLibre · Web Push"]
        bo["Backoffice<br/>Next.js"]
        rider["App Motorizado<br/>React Native · MapLibre RN · ntfy"]
    end

    subgraph EDGE["Borde"]
        waf["WAF<br/>ModSecurity + OWASP CRS"]
        caddy["Caddy<br/>router · TLS · estáticos · PMTiles"]
    end

    subgraph BACKEND["Backend · Docker"]
        api["API Core<br/>NestJS monolito modular"]
        rt["Realtime<br/>Socket.IO"]
        worker["Worker<br/>BullMQ"]
    end

    subgraph DATOS["Datos"]
        pg[("PostgreSQL 16 + PostGIS")]
        valkey[("Valkey<br/>cache · colas · GEO · pub/sub")]
        s3[("SeaweedFS<br/>API S3")]
    end

    subgraph GEO["Mapas OSM · self-hosted"]
        nom["Nominatim<br/>geocoding Ecuador"]
        osrm["OSRM<br/>rutas y distancias"]
    end

    subgraph SIM["Simuladores de servicios externos"]
        paysim["pasarela-simulada<br/>webhooks HMAC"]
        cousim["courier-simulado"]
        srisim["sri-simulado"]
    end

    subgraph NOTIF["Notificaciones"]
        mail["Mailpit"]
        ntfy["ntfy"]
    end

    subgraph OBS["Observabilidad"]
        lgtm["Grafana · Prometheus<br/>Loki · Tempo · OTel"]
        kuma["Uptime Kuma"]
    end

    web & bo & rider --> waf --> caddy
    caddy -->|/api| api
    caddy -->|/ws| rt
    api --> pg & valkey & s3
    worker --> pg & valkey & s3
    rt <--> valkey
    api & worker --> nom & osrm
    api --> paysim
    paysim -.->|webhook| caddy
    worker --> cousim & srisim & mail & ntfy
    api & worker & rt -.->|OTLP| lgtm
```

| Contenedor | Tecnología | Responsabilidad | Escalado |
|---|---|---|---|
| Storefront Web/PWA | Next.js | Catálogo con SSR/ISR para SEO, carrito, checkout, tracking, cuenta. Instalable como PWA. | Horizontal. |
| Backoffice | Next.js | CRUD, dashboards, bodega (picking, escaneo), tickets. Menú según permisos. | Estático. |
| App Motorizado | React Native + Expo | Turnos, ofertas de pedido, navegación, GPS cada 10-15 s, foto, firma, OTP, cobro contra entrega. | — |
| API Core | NestJS | Toda la lógica de negocio. Sin estado en memoria. | Horizontal (réplicas detrás de Caddy). |
| Realtime | NestJS + Socket.IO | Canales `order:{id}` y `rider:{id}`. | Horizontal con adaptador Valkey. |
| Worker | NestJS + BullMQ | Colas, cron (carrito abandonado, franjas, conciliación, liquidaciones), relay del outbox. | Por profundidad de cola. |
| PostgreSQL | PostGIS 16 | Fuente de verdad. | Vertical; réplica de streaming opcional para reportes. |
| Valkey | Valkey 8 | Cache, colas BullMQ, rate limiting, `GEOADD` de motorizados, locks, pub/sub. | Réplica/cluster en V2. |
| SeaweedFS | API S3 | Imágenes, videos, modelos AR, XML y PDF del SRI, pruebas de entrega. | Volúmenes adicionales. |
| Nominatim / OSRM | OSM Ecuador | Geocoding de direcciones; distancia real por calle y ETA. | — |
| Simuladores | NestJS/Node | Imitan pasarelas, SRI y couriers con webhooks firmados. | — |

**Búsqueda:** en el MVP, Full-Text Search de PostgreSQL (`tsvector` con diccionario `spanish` + `pg_trgm`). En V2, Meilisearch detrás del `SearchPort`.

## 1.3 Nivel 3 — Componentes del API Core

```mermaid
flowchart LR
    subgraph IF["Capa de interfaz"]
        rest["REST /v1<br/>Controllers · DTOs · OpenAPI"]
        hooks["Webhooks entrantes<br/>Pagos · Couriers<br/>verificación HMAC"]
        cons["Consumidores BullMQ<br/>+ Cron"]
    end

    subgraph MOD["Módulos de dominio · cada uno con su schema"]
        iam["IAM<br/>usuarios, roles, permisos,<br/>JWT, 2FA, consentimientos"]
        cat["Catálogo<br/>productos, variantes, media,<br/>búsqueda, reseñas, P&R"]
        inv["Inventario<br/>stock por bodega, reservas,<br/>movimientos, compras"]
        cart["Carrito y Checkout<br/>carrito, invitado,<br/>orquestación del checkout"]
        promo["Promociones<br/>cupones, 2x1, envío gratis,<br/>gift cards"]
        ord["Pedidos<br/>máquina de estados,<br/>devoluciones y cambios"]
        pay["Pagos<br/>intents, captura,<br/>reembolsos, conciliación"]
        bill["Facturación SRI<br/>factura, nota de crédito,<br/>firma XAdES, secuenciales"]
        log["Logística<br/>zonas, tarifas, despacho,<br/>couriers, tracking, POD"]
        crm["Clientes y Fidelización<br/>direcciones, puntos,<br/>niveles, referidos, wishlist"]
        sup["Soporte<br/>tickets, SLA"]
        rep["Reportes<br/>KPIs, exportes Excel/PDF"]
        notif["Notificaciones<br/>plantillas, preferencias,<br/>multicanal"]
    end

    subgraph SK["Shared kernel"]
        auth["AuthGuard + PermissionGuard<br/>RBAC granular"]
        ten["TenantContext + RLS"]
        outbox["Outbox + EventBus"]
        audit["AuditInterceptor"]
        idem["Idempotency middleware"]
    end

    subgraph AD["Adaptadores de puertos externos"]
        pgw["PaymentGatewayPort<br/>Simulador · (Datafast, Payphone,<br/>Medianet, DeUna, Pichincha)"]
        crp["CourierPort<br/>Simulador · (Servientrega)"]
        srip["SriPort<br/>Simulador · ambiente pruebas"]
        mapp["MapsPort<br/>Nominatim · OSRM"]
        chp["ChannelPort<br/>Email · Web Push · ntfy"]
        stp["StoragePort (S3) · SearchPort"]
    end

    rest --> MOD
    hooks --> pay
    hooks --> log
    cons --> MOD

    cart --> inv
    cart --> promo
    cart --> log
    cart --> pay
    cart --> ord
    ord --> inv

    pay --> pgw
    log --> crp
    log --> mapp
    bill --> srip
    notif --> chp
    cat --> stp

    ord -. "OrderPaid, OrderDelivered" .-> outbox
    outbox -. eventos .-> bill
    outbox -. eventos .-> log
    outbox -. eventos .-> notif
    outbox -. eventos .-> crm
```

### Detalle del módulo Logística

```mermaid
flowchart TB
    subgraph LOGISTICA["Módulo Logística"]
        quote["DeliveryQuoteService<br/>cotiza en el checkout"]
        zone["ZoneResolver<br/>PostGIS ST_Covers(punto, zona)"]
        rules["DeliveryRulesEngine<br/>reglas priorizadas por tenant"]
        rprice["RiderPricing<br/>base + km (OSRM) + peso/volumen + franja"]
        agg["CourierQuoteAggregator<br/>cotiza en paralelo, timeout 3 s"]
        rate["RateCardFallback<br/>tarifario local si la API falla"]
        slots["SlotService<br/>franjas y capacidad"]
        disp["DispatchService<br/>asignación automática"]
        score["RiderScoring<br/>distancia, carga actual,<br/>rating, tiempo en turno"]
        offer["OfferManager<br/>oferta con timeout 45 s<br/>y reintento con el siguiente"]
        label["LabelService<br/>guías y etiquetas PDF/ZPL"]
        track["TrackingService<br/>normaliza estados<br/>propios y de couriers"]
        pod["ProofOfDeliveryService<br/>foto, firma, OTP, geocerca"]
        settle["SettlementService<br/>comisiones, cobro contra entrega,<br/>liquidaciones"]
    end

    quote --> zone --> rules
    rules -->|"zona con cobertura propia<br/>y capacidad en la franja"| rprice
    rules -->|"fuera de cobertura, sin capacidad<br/>o peso/volumen excedido"| agg
    agg --> serv["CourierSimuladoAdapter<br/>(ServientregaAdapter en producción)"]
    agg -.->|falla o timeout| rate
    quote --> slots

    disp --> score
    score --> geo[("Valkey GEO<br/>GEOSEARCH radio 5 km")]
    disp --> offer
    agg --> label
    track --> rtg["Realtime Gateway"]
    pod --> s3[("SeaweedFS")]
```

### Estructura del código

```text
apps/
  api/            # bootstrap HTTP
  worker/         # bootstrap de consumidores BullMQ y cron
  realtime/       # bootstrap WebSocket
libs/
  modules/
    catalog/
      api/             # controllers + DTOs
      application/     # casos de uso
      domain/          # entidades, value objects, eventos, reglas
      infrastructure/  # repositorios, adaptadores
      catalog.module.ts
      index.ts         # API PÚBLICA del módulo
    inventory/ ... logistics/ ... billing/ ...
  shared-kernel/  # auth, tenancy, outbox, audit, idempotency, errores
  adapters/       # payments/, couriers/, sri/, maps/, channels/
simulators/
  payments/  courier/  sri/
```

### Reglas de modularidad (verificadas en CI con dependency-cruiser)

1. Un módulo solo importa el `index.ts` de otro módulo. Excepción: `events.ts`, los contratos de eventos (nombres y payloads, sin Nest ni base), para que dos módulos se suscriban a los eventos del otro sin ciclos de imports. Las reglas se revisan con `npm run arch:check` y `npm run arch:schemas` (ver `08-despliegue.md`, 8.3).
2. Un módulo solo accede a **su propio schema**. Sin joins entre schemas, salvo Reportes.
3. Efectos secundarios entre módulos **por eventos**, no por llamadas directas.
4. Cada adaptador externo implementa un *port*. Cambiar el simulador por el proveedor real = una clase nueva.

Candidatos a extraerse como servicios en V2/V3: **Tracking/Realtime**, **Notificaciones**, **Búsqueda**, **Facturación SRI**.

### Eventos de dominio principales

| Evento | Productor | Consumidores |
|---|---|---|
| `OrderPlaced` | Pedidos | Inventario, Notificaciones, Logística (si es contra entrega) |
| `PaymentCaptured` / `PaymentFailed` | Pagos | Pedidos, Notificaciones |
| `OrderPaid` | Pedidos | Facturación SRI, Logística, Fidelización |
| `ShipmentAssigned` / `ShipmentStatusChanged` | Logística | Pedidos, Notificaciones, Realtime. Hoy `ShipmentStatusChanged` se emite al cancelar envíos pendientes y al recibir un retiro en bodega; el despacho lo emitirá con el mismo contrato |
| `OrderDelivered` | Pedidos | Fidelización, Liquidaciones, solicitud de reseña |
| `ReturnRequested` · `ReturnApproved` · `ReturnReceived` · `ReturnInspected` · `ReturnRefunded` · `ReturnExchanged` | Pedidos | Notificaciones. El retiro (Logística), el stock (Inventario) y el reembolso (Pagos) los compone el orquestador de posventa en la misma transacción que cada paso, como Checkout |
| `RefundSucceeded` / `RefundFailed` | Pagos | Pedidos (devolución y pedido reembolsados), Facturación SRI (nota de crédito), Notificaciones |
| `InvoiceAuthorized` / `InvoiceRejected` | Facturación | Notificaciones, Soporte (`InvoiceRejected` abre un ticket interno) |
| `StockBelowThreshold` | Inventario | Notificaciones, Compras |
| `CartAbandoned` | Carrito (cron) | Notificaciones (1 h, 24 h, 72 h; marketing: exige consentimiento en `iam.consents`) |
| `TicketCreated` · `TicketReplied` · `TicketClosed` | Soporte | Notificaciones (acuse, respuesta del agente y encuesta CSAT por email, con un enlace firmado al ticket) |
| `TicketSlaBreached` | Soporte (cron) | Notificaciones (alerta ntfy al backoffice) |
