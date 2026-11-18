# Courier simulado

Imita la API de un courier nacional (tipo Servientrega), que no tiene equivalente open source (ADR-10).
Node 24 puro, sin dependencias. El estado vive en memoria: se pierde al reiniciar el contenedor.

| Ruta | Qué hace |
|---|---|
| `POST /v1/quotes` | Cotiza `ESTANDAR` y `EXPRESS` con su tarifario (`tariffs.mjs`) más un 4 % de recargo por combustible |
| `POST /v1/shipments` | Crea el envío y la guía. Es idempotente por `reference` + `serviceCode` (201 la primera vez, 200 después) |
| `GET /v1/shipments/:guia` | Estado e historial |
| `GET /v1/shipments/:guia/label.pdf` | Guía de 4×6" con código de barras Code 39 (PDF escrito a mano, `label-pdf.mjs`) |
| `POST /v1/shipments/:guia/cancel` | Anula la guía (solo en `GUIA_GENERADA`) |
| `GET/POST /admin/config` | `latencyMs`, `failRate`, `autoAdvance`, `stepMs`, `failedAttemptRate` (cambian en caliente) |
| `GET /admin/shipments` · `POST /admin/shipments/:guia/advance` | Lista los envíos y avanza uno a mano (`{"status":"NOVEDAD"}` es opcional) |
| `GET /events` · `POST /events/:id/resend` | Webhooks enviados, con sus entregas, y reenvío del mismo evento |

Las rutas `/v1/*` exigen el header `x-api-key: $API_KEY`. `/admin` y `/events` son la consola del simulador
y no piden clave, igual que `/events` en la pasarela de pagos.

**Estados**: `GUIA_GENERADA → RECOLECTADO → EN_TRANSITO → EN_REPARTO → ENTREGADO`. Un reparto puede terminar en
`NOVEDAD` (intento fallido, con probabilidad `failedAttemptRate`); tras 2 novedades el envío pasa a `DEVUELTO`.
Cada cambio se notifica a `WEBHOOK_URL` con `X-Couriersim-Signature: t=<unix>,v1=HMAC-SHA256(secreto, "<t>.<cuerpo>")`.
Si la tienda no responde 2xx/4xx, se reintenta a los 1, 3, 9 y 27 s.

**Tarifario**: la tienda tiene su copia negociada en `logistics.courier_rate_cards`, que carga el seed del backend.
La usa como respaldo cuando esta API no responde en 3 s. Los precios coinciden salvo el recargo por
combustible, así que en la demo se ve de dónde salió cada cotización.

```bash
node --test                                     # tests
docker compose --profile sims up -d courier-simulado
curl -X POST localhost:8082/admin/config -H 'content-type: application/json' -d '{"latencyMs":5000}'  # fuerza el respaldo
```

Variables: `WEBHOOK_URL`, `WEBHOOK_SECRET`, `API_KEY` (obligatorias); `LATENCY_MS`, `FAIL_RATE`, `STEP_MS`,
`FAILED_ATTEMPT_RATE`, `AUTO_ADVANCE` (opcionales).
