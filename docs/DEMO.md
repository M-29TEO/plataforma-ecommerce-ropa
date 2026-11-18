# Guion de la demostración

Recorrido de punta a punta de la plataforma en ~20 minutos, con un solo pedido que pasa por todos
los módulos: **compra como invitado → pago simulado → asignación de motorizado → tracking en vivo →
entrega con código (OTP) → factura autorizada por el SRI → devolución con nota de crédito →
dashboard del gerente**.

Todo corre en un PC con Docker, con datos de demostración: un catálogo de 50 productos y 3 meses
de pedidos, para que los reportes muestren tendencias. Los servicios externos (pasarela de pago,
SRI y courier) son simuladores propios (ver `docs/02-stack-open-source.md`).

> Verificado de punta a punta el 2026-10-12 desde un clon limpio: `docker compose up` sobre
> volúmenes vacíos, los 8 actos por la interfaz con Playwright y por la API, y los exportes a Excel
> y PDF.

## 0. Preparación (una vez, ~10 minutos)

**Requisitos:** Docker Desktop con 8 GB de RAM para Docker, e internet en la primera corrida (para
descargar las imágenes y las teselas de OpenStreetMap del mapa). Puertos libres en el PC: 80, 5432,
6379, 8333, 8025, 1025, 8090, 8081, 8082 y 8083.

```bash
cp .env.demo.example .env
docker compose up -d --build
```

La primera vez construye las imágenes (unos 10 minutos). Luego, en este orden y sin intervención:

1. genera el certificado de firma del SRI (autofirmado);
2. aplica las migraciones;
3. carga el seed de demo, que tarda unos 15 segundos;
4. levanta la tienda, el backoffice, la API, el worker, el realtime y los simuladores.

Está lista cuando `docker compose ps` muestra la API como `healthy`. El resumen del seed se ve con:

```bash
docker compose logs seed
```

Si algún puerto está ocupado (`port is already allocated`), cámbialo en `.env` (`PAYSIM_PORT`,
`COURIERSIM_PORT`, `SRISIM_PORT`) y vuelve a correr `docker compose up -d`.

| Qué | Dónde |
|---|---|
| Tienda | http://localhost |
| Backoffice | http://localhost/admin |
| Correos (facturas, avisos) | http://localhost:8025 (Mailpit) |
| Pasarela de pago simulada | http://localhost:8081 (se abre sola al pagar) |

**Usuarios del backoffice.** La contraseña de todos es `Demo-2026-segura`.

| Rol | Usuario | Lo usa en el acto |
|---|---|---|
| Logística | `logistica@demo.test` | 3 (despacho) |
| Soporte | `soporte@demo.test` | 7 (registrar y aprobar la devolución) |
| Bodega | `bodega@demo.test` | 7 (recibir e inspeccionar) |
| Gerente | `gerente@demo.test` | 7 (aprobar el reembolso) y 8 (dashboard) |
| Motorizado | `moto@demo.test` (Carlos Andrade) | 4 y 5, si se usa la app en un teléfono |
| Administrador | `admin@demo.test` | No hace falta; pide 2FA con el secreto que imprime el seed |

**Ventanas.** El backoffice guarda una sesión por navegador. Ten la tienda en una ventana normal y el
backoffice en una ventana privada, y cambia de rol con **Salir**.

**Volver a empezar desde cero:** `docker compose down -v && docker compose up -d`.

### Qué datos trae el seed

- **Catálogo:**
  - 50 productos de 5 marcas (inventadas), en 14 categorías;
  - variantes por color y talla, con stock (algunas tallas agotadas o con pocas unidades);
  - costo de cada producto, para calcular el margen;
  - ilustraciones propias en SVG, sin fotos de terceros.
- **Quito:** 5 zonas de cobertura:
  - Norte, Centro Histórico, Sur y Valle de los Chillos, atendidas con motorizado y franjas horarias;
  - Cumbayá-Tumbaco, atendida por el courier simulado.
- **Motorizados:** 6, cada uno con su zona base, su puntualidad y su calificación.
- **Clientes:** 120 registrados, con dirección por barrio, más compras de invitados.
- **Historial:** unos 860 pedidos de los últimos 90 días (hasta ayer):
  - crecimiento mes a mes, más ventas en fines de semana y quincenas, y un pico en la "Semana de la moda" de hace un mes;
  - pagos con tarjeta, transferencia, contra entrega y DeUna;
  - entregas a tiempo o tarde según el motorizado, y calificaciones;
  - cancelaciones y devoluciones reembolsadas;
  - unos 1 400 carritos abandonados, para el embudo de conversión;
  - liquidaciones semanales de los motorizados.

  Los pedidos históricos no tienen factura electrónica: solo la emiten los pedidos que se hacen en vivo.

## 1. Compra como invitado (tienda)

1. Abre http://localhost. Muestra la portada, el menú Mujer, los filtros por talla y color y la
   búsqueda (prueba "lino").
2. Entra a **Vestido midi de lino**. Abre la **Guía de tallas**, elige un color y una talla
   disponible y pulsa **Agregar al carrito**. En el carrito, pulsa **Pagar**.
3. En el checkout aparece "Compras como invitado." Completa:
   - Nombre y apellido: `Valeria Ortega`
   - Celular: `0987654321`
   - Correo: `valeria.ortega@correo.test` (allí llegan la factura y los avisos, en Mailpit)
   - Calle principal: `Av. Amazonas`; calle secundaria: `Calle Valladolid`
4. **Pin en el mapa:** haz clic en el mapa sobre La Carolina o Iñaquito (Quito Norte), o arrastra el
   pin. "📍 Usar mi ubicación" sirve solo si el PC está en una zona de cobertura.
5. Aparecen las opciones de envío: **Motorizado propio · Quito Norte**, con las franjas del día.
   Muestra que el envío sale gratis desde $50.
6. **Factura:** desmarca **"Consumidor final (sin datos)"**. Deja el tipo en Cédula y escribe el número
   `1710034065`. El paso es obligatorio por dos reglas del SRI:
   - sobre $50, la factura debe llevar la identificación del comprador;
   - sin identificación no hay nota de crédito en el acto 7, porque el SRI no la admite a consumidor
     final.
7. Elige **Tarjeta de crédito o débito** y pulsa **Pagar $…**.

## 2. Pago simulado (pasarela)

1. El navegador va a la pasarela simulada (puerto 8081). Explica que es un simulador propio: la API
   real de una pasarela no es gratuita. El simulador firma sus webhooks con HMAC, como lo haría la
   pasarela real.
2. Pulsa **Aprobar pago**. Luego pulsa **Volver a la tienda**.
3. La tienda muestra **¡Pago confirmado!** con el número de pedido (`Pedido #100…`). Anótalo.
4. En Mailpit (http://localhost:8025) ya están los correos "Recibimos tu pedido" y "Pago confirmado".

> Variante: con **Rechazar pago**, el pedido queda **Cancelado** y el pago, como fallido. Muéstralo en
> un segundo pedido, no en el del guion.

## 3. Asignación de motorizado (backoffice, Logística)

1. Ingresa en http://localhost/admin como `logistica@demo.test`.
2. Ve a **Logística › Despacho**. En la cola de envíos por despachar, elige la fila con destino
   **Av. Amazonas y Calle Valladolid**. La columna Pedido muestra el inicio del id, no el número.
3. A la derecha están el mapa del destino y la lista de motorizados. Elige **Carlos Andrade** y pulsa
   **Asignar envío**.
4. Opcional: **Logística › Mapa en vivo** muestra a los motorizados. En el acto 4 se ve moverse a
   Carlos.

> Alternativa: **Ofrecer al mejor disponible (app)** hace un despacho automático. Puntúa a los
> motorizados con turno activo y les avisa por ntfy. Necesita la app en un teléfono con el turno
> iniciado.

## 4. Tracking en vivo (tienda + motorizado)

1. En la pestaña de la tienda, pulsa **Seguir mi pedido**. La página es pública: tiene un token en la
   URL y no pide sesión.
2. Mueve al motorizado. Sin teléfono, usa el simulador desde una terminal en la carpeta del repo
   (cambia `100870` por tu número de pedido):

   ```bash
   docker compose exec -e NODE_ENV=development api node dist/scripts/sim-rider.js 100870 0000
   ```

   El simulador retira el pedido en la bodega y recorre la ruta enviando su GPS cada 2 segundos,
   como la app. El `0000` es a propósito un código equivocado, para el acto 5.
3. En la tienda, sin recargar la página (Socket.IO):
   - el estado cambia a **Tu pedido está en camino**;
   - el 🛵 avanza por el mapa;
   - se ve el tiempo estimado ("Llega en ~N min") y la línea de tiempo;
   - aparece el **Código de entrega**, de 4 dígitos.

> **Con la app del motorizado en un teléfono Android** (ver `rider-app/README.md`): el teléfono y el PC
> deben estar en la misma Wi-Fi. Antes de levantar, pon `NTFY_PUBLIC_URL=http://<IP del PC>:8090` en
> `.env` y compila el APK con `EXPO_PUBLIC_API_URL=http://<IP del PC>/api`. Ingresa con
> `moto@demo.test` e inicia el turno; el envío asignado aparece en la app. La entrega exige estar a
> pocos metros del destino, así que en el acto 1 el pin debe ir donde está el teléfono, dentro de
> una zona de Quito. Si no estás en Quito, usa el simulador.

## 5. Entrega con código OTP

1. Al llegar, el simulador intenta entregar con `0000` y la API lo rechaza:
   `422 OTP_INVALID · El código de entrega no es correcto (quedan 4 intentos)`. El pedido sigue en
   **Llegando**. Al quinto error, la entrega se bloquea.
2. La clienta le dicta al motorizado el código que ve en la tienda. Vuelve a correr el simulador con
   ese código (por ejemplo `5423`):

   ```bash
   docker compose exec -e NODE_ENV=development api node dist/scripts/sim-rider.js 100870 5423
   ```

   Como el motorizado ya está llegando, solo reintenta la entrega, con foto, firma y código.
3. La tienda muestra **Tu pedido fue entregado** y el 🛵 desaparece del mapa. En Mailpit llega "¡Tu
   pedido #… fue entregado!".

## 6. Factura autorizada (SRI simulado)

La factura se emite al confirmarse el pago, en el acto 2; con contra entrega, al entregar.

1. En Mailpit, abre **Factura electrónica 001-001-00000000N - Moda Demo**. Trae dos adjuntos:
   - el **RIDE** en PDF, con el código de barras de la clave de acceso;
   - el **XML** firmado con XAdES-BES.
2. En el backoffice, abre **Ventas › Pedidos** y luego el pedido. La sección **Comprobantes
   electrónicos** muestra la factura **Autorizado**, con su número de autorización, y los botones
   **RIDE (PDF)** y **XML**.
3. Puntos para comentar:
   - el flujo con el SRI: recepción → autorización, con reintentos;
   - la clave de acceso de 49 dígitos;
   - el ambiente de pruebas;
   - el certificado es autofirmado, porque la firma real tiene costo.

## 7. Devolución con nota de crédito (backoffice)

La clienta llama porque el vestido le quedó pequeño. Como compró sin cuenta, la devolución la
registra soporte. Un cliente con cuenta la pide él mismo en **Mi cuenta › Mis pedidos**, con fotos.

1. **Soporte** (`soporte@demo.test`):
   1. Abre **Ventas › Pedidos**, luego el pedido, y pulsa **Registrar devolución**.
   2. Pon cantidad `1`, motivo **Talla pequeña** y resolución **Reembolso al medio de pago**. Pulsa
      **Registrar devolución**.
   3. Se abre la devolución `RMA-<pedido>-1`. Pulsa **Aprobar** y confirma. Aprobar programa el
      retiro con Logística.
2. **Bodega** (`bodega@demo.test`):
   1. Abre **Ventas › Devoluciones**, luego la RMA, y pulsa **Recibir en bodega** → **Confirmar recepción**.
   2. Pulsa **Inspeccionar**. Deja la condición en "Nuevo (con etiquetas)" y "Vuelve al stock", y pulsa
      **Registrar inspección**. La prenda vuelve al stock vendible y se solicita el reembolso.
3. **Gerente** (`gerente@demo.test`):
   1. En la misma RMA, pulsa **Aprobar reembolso** → **Aprobar**. El reverso va a la pasarela
      simulada. Por encima de $100 se piden dos aprobaciones de personas distintas.
   2. En unos segundos aparece la **Nota de crédito** **Autorizado**, ligada a la factura, con su RIDE y
      su XML. Recarga la página si no aparece. En Mailpit llega "Nota de crédito electrónica…".
   3. El pedido queda **Devuelto**.

## 8. Dashboard del gerente

1. Como `gerente@demo.test`, abre **Gerencia › Dashboard de KPIs**. El rango por defecto es 30 días,
   comparado con los 30 anteriores. Muestra:
   - **KPIs:** ventas netas, pedidos, ticket promedio, margen, conversión, carritos abandonados,
     entregas a tiempo y tiempo del pago a la entrega.
   - **Ventas en el tiempo**, por día, semana o mes: el pico de la Semana de la moda y los fines de
     semana.
   - **Lo más vendido**, por producto, categoría, talla o color.
   - **Embudo de conversión.**
   - **Desempeño de entregas** por courier, tipo, zona y **motorizado**: Luis Quishpe es el menos
     puntual.
2. El pedido de la demo entra al dashboard en menos de un minuto: en la demo, las vistas se refrescan
   cada minuto (`REPORTS_REFRESH_EVERY_MS` en `.env`; por defecto, cada 15).
3. **Exportar a Excel / PDF** genera el reporte en segundo plano. Se descarga desde **Gerencia ›
   Exportes**.

## Si algo falla

| Síntoma | Causa y solución |
|---|---|
| `docker compose up` termina con `service "seed" didn't complete successfully` | `docker compose logs seed`. Si dice que el tenant "demo" ya existe con otro id, la base no está vacía: `docker compose down -v` y vuelve a levantar. |
| La tienda responde 502 | La API o la tienda todavía arrancan: espera a que la API esté `healthy` (`docker compose ps`). |
| No hay opciones de envío en el checkout | El pin quedó fuera de las zonas: ponlo en Quito Norte (La Carolina, Iñaquito). |
| No aparece la nota de crédito | La factura salió a consumidor final (acto 1, paso 6): el SRI no lo admite. Repite la compra con cédula. |
| El simulador dice "no tiene un envío con motorizado pendiente" | El pedido se entregó o se eligió retiro en tienda; o se asignó a otro motorizado distinto de Carlos Andrade. |
| El simulador falla con 401 a mitad de camino | El PC entró en suspensión y su token de 15 minutos venció: vuelve a correr el mismo comando, retoma donde quedó. |
| "Demasiados intentos" al ingresar | El límite de login está apagado en `.env.demo.example` (`RATE_LIMIT_ENABLED=false`); si lo activaste, espera un minuto. |
| La búsqueda de direcciones o la ruta por calles no funcionan | Nominatim y OSRM no se levantan en la demo (perfil `maps`, varios GB). La cotización usa distancia en línea recta y el cliente marca el pin a mano. |

**Grafana y mapas propios.** La demo levanta solo lo necesario. Para el perfil `obs` (Grafana,
alertas a ntfy) o el perfil `maps` (Nominatim y OSRM), haz lo siguiente:

1. Agrégalos a `COMPOSE_PROFILES` en `.env`.
2. Borra de `.env` las líneas `NOMINATIM_URL=`, `OSRM_URL=` y `OTEL_EXPORTER_OTLP_ENDPOINT=`.

Si se dejan vacías, la API no busca esos servicios. Si apuntan a un servicio que no está levantado,
cada consulta tarda segundos en fallar en el DNS de Docker y frena la API entera.
