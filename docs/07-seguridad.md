# Entregable 7 — Seguridad: OWASP Top 10 y LOPDP

Revisión del backend (API y worker NestJS) frente al **OWASP Top 10 2021** y a la **LOPDP** (Ley
Orgánica de Protección de Datos Personales del Ecuador). El documento cubre qué se revisó, qué se
encontró, cómo se corrigió y qué riesgo queda. También explica cómo repetir la revisión con
herramientas open source.

- **Fecha:** 2026-10-02.
- **Versión revisada:** v0.5 más IAM completo (login, 2FA y RBAC).
- **Alcance:** 28 archivos de controladores y unas 200 operaciones HTTP, el worker (jobs y consumidores),
  `docker-compose.yml`, `infra/Caddyfile` y el `Dockerfile`.
- **Fuera de alcance:** storefront, backoffice y apps móviles (todavía no existen) y los
  simuladores (no son parte del producto).

## 7.1 Método

| Paso | Herramienta | Qué aporta |
|---|---|---|
| Revisión manual por categoría OWASP | Lectura de cada controlador, servicio y repositorio | Control de acceso por tenant y dueño (IDOR), lógica de negocio y flujo de secretos |
| SAST | **Semgrep** (LGPL): reglas `p/owasp-top-ten`, `p/nodejs`, `p/typescript` y `p/secrets` + reglas propias en `.semgrep.yml` | Patrones inseguros en el código |
| SCA, misconfig y secretos | **Trivy** (Apache 2.0) | CVE en dependencias de producción; Dockerfile y compose; secretos versionados |
| DAST | **OWASP ZAP** (Apache 2.0), `zap-api-scan` | Ataque real (pasivo y activo) a la API levantada en Docker |
| Guardianes en los tests | Jest + Testcontainers | Que lo corregido no vuelva a romperse |

## 7.2 Resumen de hallazgos

| Sev. | OWASP | Hallazgo | Estado |
|---|---|---|---|
| Alta | A01/A10 | Path traversal hacia SeaweedFS con las claves de fotos de devoluciones (`../`) y de reseñas (`%2e%2e`): permitía leer comprobantes, XML del SRI o exportes de otros tenants | Corregido |
| Alta | A10 | SSRF por el `endpoint` de Web Push: el worker hacía POST a IPs internas y la respuesta se podía leer en `GET /me/notifications` | Corregido |
| Media | A01 | Suscripción push reasignable a otro usuario (`ON CONFLICT ... SET user_id`) | Corregido |
| Media | A01 | IDOR en exportes de reportes: cualquiera con `reports.export` descargaba exportes ajenos | Corregido |
| Media | A01 | Un motorizado podía llevar cualquier pedido a cualquier estado | Mitigado (ver 7.6) |
| Media | A01 | Inventario aceptaba un `variantId` de otro tenant | Corregido |
| Media | A01 | `X-Tenant-Id` de peticiones anónimas sin fijar en Caddy | Corregido |
| Media | A03 | Plantillas Handlebars del tenant con `{{{ }}}` / `{{& }}`: inyección de HTML en emails | Corregido |
| Media | A04 | El cliente podía cambiar el comprobante de transferencia mientras el staff lo revisaba | Corregido |
| Media | A04 | Webhooks sin firma se guardaban en `webhook_inbox` (escritura ilimitada) | Corregido |
| Media | A04/A07 | Sin rate limiting: cupones, referidos, `guest-tickets` y login se podían probar sin límite | Corregido |
| Media | A04 | Una misma persona aprobaba y pagaba una liquidación de motorizado (sin segregación de funciones) | Corregido |
| Media | A02 | `JWT_SECRET` sin longitud mínima; del mismo secreto se derivan otros HMAC | Corregido en producción |
| Media | A02 | Claves de Web Push (`p256dh`, `auth`) en texto plano | Corregido (`keys_enc`) |
| Media | A01 | Tokens de enlace de ticket visibles para el staff en `GET /notifications` | Corregido |
| Media | A05 | Sin helmet ni CORS; `X-Powered-By` expuesto; cuerpos JSON sin límite | Corregido |
| Media | A09 | 401, 403 y firmas inválidas no quedaban en ningún log; no existía escritor general de `audit_log` | Corregido |
| Baja | A03/A04 | ~40 huecos de validación en DTOs (strings, números, arrays y objetos sin cota) | Corregido |
| Baja | A08 | Content-Type de fotos y comprobantes tomado del cliente y servido `inline` | Corregido |
| Baja | A05 | El 403 enumeraba los permisos faltantes; los errores exponían el nombre de la restricción SQL | Corregido |
| Baja | A05 | `token:dev` (staff con todos los permisos, 8 h) sin freno en producción | Corregido |
| Baja | A09 | La IP de los consentimientos era la de Caddy (sin `trust proxy`) | Corregido |
| Baja | A06 | `uuid@8` (CVE-2026-41907, MEDIUM) por `exceljs` | Corregido (`overrides`) |
| Baja | A05 | Imagen Docker sin `HEALTHCHECK` | Corregido |
| Baja | A05 | **ZAP:** un byte nulo (`%00`) en los filtros de texto daba 500 (PostgreSQL rechaza `\0`, SQLSTATE 22021) en 4 rutas | Corregido |
| Baja | A05 | **ZAP:** `Cross-Origin-Resource-Policy: same-site` en lugar de `same-origin` | Corregido |

Lo que ya estaba bien y se verificó:
- **SQL:** todo va parametrizado. Los `${...}` dentro del SQL son constantes o columnas de una
  lista blanca (`buildSetClause`); la regla `moda-sql-interpolacion-de-entrada` no encuentra nada.
- **JWT:** solo HS256 (rechaza `alg=none`).
- **Webhooks:** HMAC comparado en tiempo constante, anti-replay por marca de tiempo e inbox
  idempotente.
- **Pertenencia:** `/me/*` filtra por dueño.
- **Reembolsos:** doble aprobación de personas distintas.
- **Gift cards:** se guarda solo el hash del código, que tiene 80 bits de azar.
- **Contraseñas y sesiones:** argon2id, bloqueo tras 5 fallos y refresh tokens rotativos con
  detección de reutilización.

## 7.3 Matriz OWASP Top 10 (2021)

### A01 — Control de acceso roto

**Controles:**
- Guard global "cerrado por defecto" (`GlobalAuthGuard`): toda ruta exige JWT salvo `@Public()`.
- RBAC con `@RequirePermission`.
- Tenant tomado del token. En anónimos lo fija **Caddy** (`header_up X-Tenant-Id`, que pisa el
  valor del cliente).
- Filtro por dueño en todo `/me/*`.

**Corregido en esta revisión:**
- **Claves de almacenamiento** (`libs/shared-kernel/storage/object-storage.ts`):
  - `assertSafeStorageKey` admite solo segmentos `[A-Za-z0-9._-]`, sin `.`/`..` ni `%`, `?`, `#`
    o `\`.
  - Cada segmento se codifica con `encodeURIComponent`.
  - Además, Devoluciones y Reseñas exigen exactamente `<prefijo del cliente>/<uuid>.(jpg|png|webp)`.
- **Reportes:** un exporte es de quien lo pidió (si no, 404) y se vuelve a exigir el permiso de
  lectura de ese reporte (403).
- **Push:** el `upsert` no reasigna un endpoint de otro usuario (409 `PUSH_ENDPOINT_TAKEN`).
- **Inventario:** valida la variante contra `CatalogApi` por tenant (404 `VARIANT_NOT_FOUND`).
- **Motorizados:** solo transiciones de entrega (`in_transit`, `delivered`).
- **Notificaciones:** la bandeja del staff oculta los enlaces firmados (`[enlace firmado oculto]`).

**Evidencia:**
- `test/platform/security.int-spec.ts`.
- `test/notifications/notifications.int-spec.ts` (SSRF y secuestro).
- `test/reports/reports.int-spec.ts`.
- `test/inventory/stock.int-spec.ts`.
- `libs/shared-kernel/security/security.spec.ts` (claves).

### A02 — Fallas criptográficas

**Controles:**
- argon2id para contraseñas.
- HMAC-SHA256 para enlaces, cotizaciones y webhooks.
- libsodium `crypto_secretbox` (XSalsa20-Poly1305) para los campos `*_enc`.
- Cookies httpOnly, `SameSite=Strict` y `Secure` fuera de desarrollo.

**Corregido:**
- **`FieldCipher`** (`libs/shared-kernel/security/field-cipher.ts`):
  - Formato `nonce(24) || cifrado+MAC` con clave `DATA_ENCRYPTION_KEY`.
  - Rotación: `DATA_ENCRYPTION_KEY_PREVIOUS` se usa para descifrar y `needsReseal` indica qué
    recifrar.
  - El 2FA (`iam.users.mfa_secret_enc`) usa el mismo formato con `MFA_ENCRYPTION_KEY`.
- **Web Push:** las claves (`p256dh`, `auth`) pasan a `platform.push_subscriptions.keys_enc`
  (migración 0015).
- **Producción:** exige `JWT_SECRET` de al menos 32 caracteres y `DATA_ENCRYPTION_KEY` de 32 bytes.
  La API no arranca sin ellas.
- **JWT:** lleva `iss` y `aud`, así un token HS256 firmado con el mismo secreto para otro fin no
  sirve como token de acceso.

**Campos `*_enc`:**

| Campo | Contenido | Clave |
|---|---|---|
| `iam.users.mfa_secret_enc` | Secreto TOTP | `MFA_ENCRYPTION_KEY` |
| `platform.push_subscriptions.keys_enc` | `{p256dh, auth}` del navegador | `DATA_ENCRYPTION_KEY` |
| `payments.customer_payment_tokens.token_enc` | Token de tarjeta guardada | `DATA_ENCRYPTION_KEY` (`FieldCipher`; todavía no hay flujo de tarjetas guardadas) |

**Uso justificado de SHA-1** (marcado `nosemgrep` en el código):
- La firma XAdES-BES que exige la ficha técnica del SRI.
- HMAC-SHA1 de TOTP (RFC 6238), que es lo que implementan las apps autenticadoras.

### A03 — Inyección

**Controles:**
- SQL siempre parametrizado.
- `ValidationPipe` global con `whitelist`, `forbidNonWhitelisted`, `forbidUnknownValues` y
  `transform`. Los errores no devuelven el valor recibido.
- Handlebars escapa las variables en HTML.

**Corregido:**
- **DTOs:** se cotaron todos los strings (`MaxLength`), números (`Min`/`Max`), arrays
  (`ArrayMaxSize`) y objetos (DTO anidado o validador de tamaño y profundidad). Ejemplos: GeoJSON
  de zonas con 2000 vértices como máximo, `offset` ≤ 10 000, cédula/RUC/pasaporte según `idType`.
- **Parámetros de ruta:** los sueltos van con pipe (`ParseUUIDPipe`, `MatchesPipe`,
  `TicketTokenPipe`).
- **Guardián:** `test/platform/dto-coverage.int-spec.ts` recorre todas las rutas de la app y falla
  si un `@Body`/`@Query`/`@Param` llega sin DTO validado ni pipe. Detectó 3 parámetros sin validar
  en esta misma revisión.
- **Plantillas:** se rechazan `{{{ }}}` y `{{& }}` (422 `UNESCAPED_TEMPLATE`).
- **Archivos servidos:** `sendStoredFile` muestra inline solo JPG, PNG, WEBP y PDF. El resto se
  descarga como `application/octet-stream`, con `nosniff` y `CSP: sandbox`, así un archivo
  manipulado no se ejecuta en el dominio de la tienda.

### A04 — Diseño inseguro

**Controles:**
- Precios y totales calculados en el servidor.
- Cotización de envío firmada.
- Reserva de stock atómica.
- Idempotency-Key en el checkout.
- Doble aprobación de reembolsos.

**Corregido:**
- **Rate limiting** (sección 7.4).
- **Comprobante de transferencia:** solo se sube desde `requires_action`; en revisión responde 409
  `VOUCHER_ALREADY_SUBMITTED`.
- **Webhooks:** la firma se verifica antes de interpretar o guardar nada.
- **Liquidaciones:** quien aprueba no puede marcar como pagada (409 `SETTLEMENT_SAME_APPROVER`).
- **Subidas:** los magic bytes deben coincidir con el tipo declarado (`sniffFileType`).

### A05 — Configuración de seguridad incorrecta

**Corregido** (`libs/shared-kernel/security/http-hardening.ts`):
- **helmet:**
  - CSP `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` (la API
    solo responde JSON y archivos).
  - `nosniff`, `Referrer-Policy: no-referrer`, HSTS, `Cross-Origin-Resource-Policy: same-origin`.
- **Cabeceras propias:** sin `X-Powered-By`; `Cache-Control: no-store` por defecto.
- **CORS estricto:**
  - Lista blanca `CORS_ORIGINS`, sin comodines (la configuración los rechaza al arrancar), con
    credenciales.
  - En Docker queda vacío: storefront y backoffice van por el mismo dominio detrás de Caddy.
- **Proxy y cuerpo:**
  - `trust proxy` acotado a la red interna (`TRUST_PROXY`): `req.ip` es la IP real del cliente
    para el rate limit y la auditoría.
  - Cuerpo JSON y urlencoded de 100 kB como máximo (413).
- **Bytes nulos:** `%00` en la URL responde 400; SQLSTATE 22021/22P05 (texto inválido) se mapean a 400 en lugar de 500.
- **Errores:**
  - El 403 es genérico ("No tienes permiso para esta operación"); el detalle va al log.
  - Los errores de PostgreSQL ya no exponen el nombre de la restricción.
- **Infraestructura:**
  - `HEALTHCHECK` en la imagen.
  - Caddy sin header `Server`; el Caddyfile se corrigió porque tenía bloques en una línea que
    Caddy rechaza.

### A06 — Componentes vulnerables y desactualizados

Trivy y `npm audit --omit=dev` encontraron una sola vulnerabilidad: `uuid@8.3.2` dentro de
`exceljs` (CVE-2026-41907, MEDIUM). Se forzó `uuid@^11.1.1` con `overrides` (verificado: exceljs
sigue generando XLSX). Resultado final: **0 vulnerabilidades** en dependencias de producción. El
workflow `.github/workflows/security.yml` vuelve a correr Trivy cada lunes para detectar CVE
nuevos.

### A07 — Fallas de identificación y autenticación

**Controles** (IAM):
- argon2id.
- Bloqueo tras 5 fallos (15 min), compartido entre contraseña y 2FA.
- Mismo error para email inexistente y contraseña errónea.
- 2FA TOTP con anti-replay en Valkey, obligatorio para admin.
- Refresh token rotativo en cookie httpOnly con `Path=/v1/auth` y detección de reutilización.
- Access token de 15 min.

**Corregido:**
- **Rate limiting:** perfil `auth` (5/min y 20/h por IP, contador compartido entre login, 2FA y
  registro).
- **Reautenticación:** se exige la contraseña antes de anonimizar la cuenta, y el intento cuenta
  en el mismo bloqueo.

### A08 — Fallas de integridad de software y datos

**Controles:**
- Webhooks firmados con HMAC sobre el cuerpo crudo, con tolerancia de tiempo.
- Enlaces firmados de tickets y cotizaciones.
- XML del SRI firmado XAdES.
- `npm ci` con lockfile en el Dockerfile.

**Corregido:**
- Firma antes que el parseo en los webhooks.
- Tipo de archivo verificado por contenido.

### A09 — Fallas de registro y monitoreo

**Corregido:**
- **Auditoría automática:**
  - `@Audited('modulo.cosa.verbo', { entity })` en 70 acciones sensibles, más las que IAM ya
    auditaba en su propia transacción (roles, reset de 2FA, reutilización de sesión).
  - Un interceptor global escribe en `platform.audit_log` actor, tipo de actor, IP real, request
    id, parámetros, cuerpo redactado (sin contraseñas, tokens, códigos ni claves) y el resultado
    (`ok`, `denied` o `failed` con su código).
  - Se registra también lo rechazado: los intentos fallidos son la señal de un ataque.
- **Inmutabilidad de `audit_log`:**
  - Es de solo inserción por trigger (migración 0015): UPDATE, DELETE y TRUNCATE fallan incluso
    para el dueño de la tabla.
  - Las particiones mensuales las crea un job del worker (migración 0014).
- **Eventos de seguridad en el log:**
  - 401, 403, 413, 423 y 429 dejan una línea JSON con IP, usuario y request id
    (`SecurityEventsFilter`).
  - Los webhooks con firma inválida también, con el id saneado.
- **`X-Request-Id`:** viene de Caddy o se genera, y se devuelve. Correlaciona el log de Caddy, el
  de la API y la auditoría.

**Acciones auditadas (resumen):**

| Módulo | Acciones |
|---|---|
| Pagos | Aprobar o rechazar transferencias, ver comprobante, completar reembolso |
| Devoluciones | Aprobar, rechazar, recibir, inspeccionar, reintentar cambio, ver fotos, aprobar reembolso |
| Pedidos | Cambio de estado (staff y motorizado), cancelación del cliente |
| Promociones | Crear o editar promociones y cupones; emitir, ajustar, bloquear o activar gift cards |
| Facturación | Descarga de XML y RIDE |
| Inventario | Ajustes y configuración de stock, órdenes de compra, bodegas, proveedores |
| Logística | Zonas, plantillas, franjas y capacidad; liquidaciones (generar, aprobar, disputar, pagar) |
| CRM | Ajuste de puntos, niveles; lectura de datos de un cliente por el staff |
| Catálogo | Moderación de reseñas y preguntas |
| Soporte | Ver, tomar, asignar y actualizar tickets |
| Notificaciones | Edición de plantillas |
| Reportes | Crear y descargar exportes |
| IAM | Consentimientos; roles, 2FA y sesiones (auditados en su transacción) |
| Privacidad | Exportar mis datos; anonimizar la cuenta (en la misma transacción) |

**Límite:** la auditoría del interceptor se escribe **después** de que la acción termina (no en su
transacción). Si la base falla justo entre una y otra, la acción queda sin fila de auditoría (sí
queda en el log). Las acciones críticas de IAM y la anonimización auditan dentro de su transacción.

### A10 — Falsificación de peticiones del lado del servidor (SSRF)

**URLs que el servidor llama:**
- OSRM, Nominatim, courier, pasarela, SRI y SeaweedFS: vienen de la configuración, no del usuario.
- La única URL del usuario era el endpoint de Web Push. Ahora va contra una lista blanca de
  servicios push (`WEBPUSH_ALLOWED_HOSTS`): solo `https`, sin credenciales ni puertos raros. Se
  revalida al enviar y ya no se guarda el cuerpo de la respuesta.

**Claves de SeaweedFS:** el path traversal (A01) era a la vez un SSRF hacia el filer; se corrigió
con `assertSafeStorageKey`.

## 7.4 Rate limiting (Valkey)

- **Implementación:** `@nestjs/throttler` con almacenamiento en **Valkey**
  (`@nest-lab/throttler-storage-redis`), `libs/shared-kernel/security/rate-limit.ts`.
  - El contador es el mismo en todas las réplicas de la API y sobrevive a reinicios.
  - La IP se guarda hasheada en la clave.
- **Ventanas:** dos por cliente, de 1 minuto y de 1 hora.
- **Respuesta al superar el límite:** 429 con `Retry-After`.

| Perfil | Límite | Rutas |
|---|---|---|
| global | 120/min, 3000/h | Toda la API |
| `auth` | 5/min, 20/h (contador compartido) | `POST /auth/register`, `/auth/login`, `/auth/login/mfa`, `/auth/mfa/setup`, `/auth/mfa/activate`, activar y desactivar 2FA, `POST /me/privacy/anonymize` |
| `checkout` | 10/min, 30/h | `POST /checkout`, `POST /checkout/delivery-options`, subida de comprobante de transferencia |
| `lookup` | 10/min, 60/h | Cupones, saldo de gift card, referidos, geocodificación, tickets de invitado y enlaces de ticket, reseñas, preguntas y fotos, exportar mis datos |
| `session` | 60/min, 1200/h | `POST /auth/refresh` (token de 256 bits: el límite solo frena abusos; con 10/min el personal detrás de una misma IP quedaba deslogueado) |

Los frontends solo llaman a `/auth/refresh` al abrir si existe la cookie no secreta `session_hint=1`
(Path=/, la deja el API junto a `refresh_token` y la borra al cerrar sesión): un visitante anónimo no
gasta el límite. Ante un 429 o un 5xx reintentan (respetando `Retry-After`, máx. 5 s); solo un 401
cierra la sesión.

`GET /payments/:id/public` se queda en el perfil global a propósito: la página de resultado
consulta el estado en bucle y exige el client secret, que no se puede adivinar.

`RATE_LIMIT_ENABLED=false` solo se usa en los tests de integración (que hacen decenas de checkouts
desde 127.0.0.1) y en el escaneo de ZAP. `test/platform/security.int-spec.ts` lo prueba encendido
contra Valkey.

## 7.5 LOPDP: derechos del titular

| Derecho | Endpoint | Detalle |
|---|---|---|
| Acceso y portabilidad | `GET /v1/me/privacy/export` | JSON descargable (`mis-datos-AAAA-MM-DD.json`) con una sección por módulo. Sin contraseñas, secretos del 2FA, tokens ni claves. Queda auditado. |
| Eliminación | `POST /v1/me/privacy/anonymize` `{ password, confirm: "ELIMINAR MI CUENTA" }` | Exige la contraseña (reautenticación, cuenta en el bloqueo) y la frase. 409 `ACCOUNT_HAS_OPEN_OPERATIONS` con la lista de pedidos, envíos o devoluciones en curso. Solo cuentas de cliente (403 para staff y motorizados). Todo en una transacción, auditada dentro de ella. |
| Consentimientos | `GET/PUT /v1/me/consents` (IAM) | Ya existía: historial de solo inserción con la versión de la política. |

**Diseño:**
- **Registro:** cada módulo registra en el `PersonalDataRegistry` del shared kernel un
  contribuyente que exporta y anonimiza **solo su propio schema** (regla de modularidad). El
  orquestador `libs/modules/privacy` no lee tablas ajenas.
- **Datos compartidos:** IAM y Pedidos aportan el email y los pedidos del titular (`resolve`) a los
  módulos que no conocen al usuario (Facturación, Logística, Notificaciones).
- **Orden:** IAM se anonimiza al final.

| Módulo | Se elimina o seudonimiza | Se conserva (y por qué) |
|---|---|---|
| IAM | Email (`anonimizado+<id>@anonimizado.invalid`), nombre, teléfono, identificación, contraseña, 2FA, sesiones, identidades, roles; estado `anonymized` | Historial de consentimientos sin IP: prueba del tratamiento autorizado |
| CRM | Direcciones, wishlist, datos del perfil (fecha de nacimiento, género, tallas, estilo, código de referido) | Saldo y movimientos de puntos, sin datos de contacto |
| Pedidos | Nombre, email y teléfono del cliente (quedan "Cliente anonimizado" y un email seudónimo); datos de facturación (pasan a consumidor final); calle, número, referencia y coordenadas de la dirección; notas de devoluciones | Montos, productos, fechas y ciudad/barrio: contabilidad y reportes |
| Carrito | Carritos no convertidos; contacto de los convertidos | — |
| Promociones | `customer_key` de los canjes (pasa a `anon:<id>`), email del destinatario de gift cards | Canjes: control de límites por cliente |
| Pagos | Tarjetas guardadas | Pagos, reembolsos y comprobantes: registros contables y tributarios |
| Facturación | Nada | **Comprobantes del SRI con los datos del comprador: se conservan 7 años** (obligación tributaria) |
| Logística | Detalle de la dirección de entrega (queda ciudad/provincia; el punto se redondea a ~1 km), nombre de quien recibió y punto de la prueba de entrega (~1 km), comentarios de calificaciones del cliente | Estados, fechas y ciudad del envío: facturación y liquidación de motorizados |
| Notificaciones | Suscripciones push; destinatario y contenido de las notificaciones (las pendientes se suprimen) | Canal, plantilla y fecha |
| Soporte | Contacto del solicitante; mensajes del cliente (reemplazados por un aviso) y comentario de la encuesta; también los tickets de invitado con su email | El ticket (asunto, categoría, estado) para las métricas de SLA |
| Catálogo | Reseñas y sus fotos (se recalcula el promedio del producto) | Preguntas sin autor |

Bloquean la anonimización (409, con la lista): pedidos, envíos y devoluciones en curso, y comprobantes que siguen en proceso con el SRI. Si no se bloqueara, el reintento enviaría datos seudónimos al SRI.

Evidencia: `test/privacy/privacy.int-spec.ts`.

## 7.6 Riesgos residuales y pendientes

| Riesgo | Por qué queda | Mitigación actual / siguiente paso |
|---|---|---|
| El motorizado puede marcar `in_transit`/`delivered` un pedido que no tiene asignado | La asignación vive en `logistics.shipments`, y Logística ya importa Pedidos (Pedidos no puede consultar Logística sin un ciclo) | Solo transiciones de entrega, y quedan auditadas. Mover esa transición a un orquestador (como `aftersales`) que valide la asignación |
| Un access token emitido antes de anonimizar sigue valiendo hasta 15 min | El JWT no se consulta contra la base en cada petición | Sesiones revocadas y contraseña borrada; el token caduca solo. Opción: lista de revocación en Valkey |
| Fotos de reseñas y de pruebas de entrega siguen en SeaweedFS tras anonimizar | `ObjectStorage` no tiene `delete` | Ya no se referencian ni se sirven. Agregar `delete` al puerto y un job de limpieza |
| Datos que la anonimización aún no toca | Texto libre o ajeno al titular: `orders.notes`, motivos de cancelación, puntos GPS del motorizado (`shipment_events`), respuesta cruda de cotizaciones de courier, calificaciones que el motorizado le puso al cliente, payloads del outbox (con `userId`), consentimientos de invitado (`iam.consents` no tiene `tenant_id`) | Siguiente iteración: un contribuyente más por cada uno y limpieza del outbox procesado |
| El enlace de ticket de invitado no se puede revocar y viaja en la ruta (queda en logs de acceso) | Es un HMAC con vigencia (30 días) sin estado | Oculto en la bandeja del staff. Siguiente: nonce por ticket guardado como hash, o token en el fragmento (`#`) |
| Un invitado puede reutilizar un cupón "uno por cliente" cambiando el email | Para invitados, la llave es el email | Rate limit `lookup`. Siguiente: normalizar emails (`+tag`, puntos de Gmail) o exigir cuenta para esos cupones |
| La auditoría del interceptor no está en la transacción de la acción | Envolver cada handler en una transacción mantendría conexiones abiertas durante llamadas externas | Queda en el log; lo crítico audita en su transacción |
| Validación de un PDF solo por magic bytes | No hay antivirus | Se sirve con CSP sandbox. Opción: ClamAV en contenedor |
| El rate limit es por IP | Una red con NAT comparte contador; una botnet lo esquiva | Bloqueo por cuenta en login (IAM) y ModSecurity/CRS en el borde |

## 7.7 Herramientas: cómo repetir la revisión

Todo corre en contenedores desechables: no instala nada en la máquina ni toca la base `moda` ni
los volúmenes del compose. Desde `backend/`:

```bash
npm run sec:semgrep   # SAST: reglas OWASP/Node/TS/secretos + .semgrep.yml
npm run sec:trivy     # SCA (CVE), Dockerfile/compose y secretos (falla con HIGH/CRITICAL)
npm run sec:scan      # ambos
npm run sec:zap       # DAST: API en Docker + OWASP ZAP (20-60 min)
npm run sec:openapi   # solo el OpenAPI (security-reports/openapi.json)
```

- **Envío del código:** `scripts/security/scan.sh` manda el código al contenedor como un tar con
  los archivos que git versionaría. Así no viajan `node_modules`, `dist` ni `secrets/`, y es mucho
  más rápido que montar una carpeta sincronizada con OneDrive.
- **Informes:** quedan en `backend/security-reports/` (ignorado por git).
- **Configuración:** `.semgrep.yml` (reglas propias), `trivy.yaml` y `.trivyignore` (aceptados,
  con justificación) en la raíz del repositorio.
- **CI:** `.github/workflows/security.yml` corre Semgrep, Trivy, typecheck y todos los tests en
  cada push y PR, y Trivy cada lunes.

`scripts/security/zap.sh` hace lo siguiente:
1. Construye la imagen real.
2. Levanta PostgreSQL (tmpfs) y Valkey en una red propia.
3. Corre migraciones y seed.
4. Emite un token de staff.
5. Genera el OpenAPI a partir de los DTOs (`scripts/security/openapi.ts`, con `class-validator-jsonschema`).
6. Corre `zap-api-scan` (pasivo + activo) con `Authorization` y `X-Tenant-Id`.
7. Al terminar, borra todo.

**Reglas propias de Semgrep (`.semgrep.yml`):**

| Regla | Detecta |
|---|---|
| `moda-sql-interpolacion-de-entrada` | `query(\`...${dto.x}...\`)` |
| `moda-fetch-con-clave-sin-sanear` | `fetch` con una clave, ruta o URL variable |
| `moda-jwt-verify-sin-algoritmos` | `jwt.verify` sin `algorithms` |
| `moda-body-sin-dto` | `@Body() x: any` / `Record<...>` |
| `moda-archivo-servido-sin-helper` | `setHeader('Content-Type', f.contentType)` fuera de `sendStoredFile` |
| `moda-comparacion-de-secreto-no-constante` | `signature === ...` |
| `moda-hash-debil` | MD5/SHA-1 |
| `moda-handlebars-sin-escape` | `compile(..., { noEscape: true })` |

## 7.8 Resultados de esta revisión

Corrida del 2026-10-05, todo en contenedores desechables.

| Herramienta | Resultado inicial | Resultado final |
|---|---|---|
| Revisión manual | 2 altas, 15 medias, ~8 bajas y ~40 huecos de DTO (tabla 7.2) | Corregidas, salvo lo listado en 7.6 |
| Semgrep (444 archivos; 4 paquetes OWASP/Node/TS/secretos + 8 reglas propias) | 4 hallazgos de las reglas propias: SHA-1 de XAdES (SRI) y de TOTP (RFC 6238), `fetch` del courier con path constante y descarga de reportes sin `sendStoredFile` | **0**: 3 falsos positivos justificados con `nosemgrep` en el código, 1 corregido |
| Trivy (dependencias de producción, Dockerfile, compose, secretos) | 1 MEDIUM (`uuid@8`, CVE-2026-41907) y 1 LOW (sin `HEALTHCHECK`) | **0 vulnerabilidades**. Queda 1 LOW en `infra/observability/uptime-kuma/Dockerfile`, de otro trabajo en curso |
| `npm audit --omit=dev` | 2 moderadas (`uuid` vía `exceljs`) | **0** |
| OWASP ZAP `zap-api-scan` (API real en Docker, `NODE_ENV=production`) | 619 URLs: 0 FAIL, 2 WARN (500 con `%00` en 4 rutas; CORP `same-site`), 117 PASS | 640 URLs: **0 FAIL, 0 WARN, 118 PASS** |

La pasada inicial de ZAP corrió sobre un código que ya tenía corregidos los hallazgos de la revisión manual.

Observaciones informativas de ZAP que se aceptan:
- 403/404 en rutas sin permiso o con ids de ejemplo (es lo esperado).
- "Authentication Request Identified" en `/auth/login`.
- `userId` en la query de los filtros del backoffice: es un uuid, no un secreto.
- "Non-Storable Content": `no-store` es intencional.

Tests (Jest + Testcontainers, PostgreSQL + PostGIS y Valkey desechables):

| Suite | Resultado |
|---|---|
| Unitarios (`npm run test:unit`) | 54 archivos, **715/715** |
| Integración (`npm run test:int`) | 34 archivos, **398/398** |
| Typecheck (`tsc`) | Sin errores |

`crm/infrastructure/geocoding/nominatim.geocoder.spec.ts` mide timeouts reales y a veces falla cuando la máquina está muy cargada (por ejemplo, con la suite de integración corriendo en paralelo); solo, pasa siempre. Ese archivo no cambió en esta revisión.

Tests nuevos de esta revisión:
- `libs/shared-kernel/security/security.spec.ts`: claves de almacenamiento, magic bytes, lista blanca push, redacción, `FieldCipher` y rotación, configuración de producción.
- `test/platform/security.int-spec.ts`: cabeceras, CORS, 413, mass assignment, 403 genérico, byte nulo, rate limit con Valkey (login, checkout, global), auditoría (`ok`/`failed`) y `audit_log` append-only.
- `test/platform/dto-coverage.int-spec.ts`: guardián de validación de todas las rutas.
- `test/privacy/privacy.int-spec.ts`: exportar, bloqueos, contraseña, anonimización y su auditoría.
- Aserciones en los int-spec de cada módulo: SSRF y secuestro de push, plantillas sin escape, IDOR de reportes, segregación de funciones en liquidaciones, variantes de otro tenant, comprobante en revisión, webhook sin firma, transiciones del motorizado y cotas de cada DTO.

## 7.9 Checklist de producción

- [ ] `JWT_SECRET`: 32 caracteres aleatorios o más (`openssl rand -base64 48`); la API no arranca
  sin él.
- [ ] `DATA_ENCRYPTION_KEY` y `MFA_ENCRYPTION_KEY`: 32 bytes en base64 cada una, distintas, fuera
  del repositorio (SOPS + age). Para rotar: la vieja en `*_PREVIOUS`, recifrar y quitarla.
- [ ] Secretos propios para `DELIVERY_QUOTE_SECRET`, `SUPPORT_LINK_SECRET` y
  `MFA_CHALLENGE_SECRET` (si no, se derivan de `JWT_SECRET`).
- [ ] `CORS_ORIGINS` vacío (mismo dominio) o solo los orígenes reales.
- [ ] `STORE_TENANT_ID` en el `.env` de Caddy.
- [ ] La API sin puertos publicados: solo Caddy (y ModSecurity delante).
- [ ] `RATE_LIMIT_ENABLED=true`, `RATE_LIMIT_STORAGE=valkey`; Valkey con contraseña si sale de la
  red interna.
- [ ] `SECURE_COOKIES=true` (por defecto fuera de desarrollo) detrás de HTTPS.
- [ ] `npm run sec:scan` sin bloqueantes y `npm run sec:zap` revisado antes de cada entrega.
