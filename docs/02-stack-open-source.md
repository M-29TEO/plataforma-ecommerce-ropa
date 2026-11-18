# Entregable 2 — Stack tecnológico (open source y sin costo)

## 2.1 Base del stack

| Capa | Herramienta | Licencia |
|---|---|---|
| Lenguaje | TypeScript / Node.js | Apache 2.0 / MIT |
| Backend | NestJS | MIT |
| ORM y migraciones | Prisma o TypeORM | Apache 2.0 / MIT |
| Storefront y backoffice | Next.js + React | MIT |
| App motorizado y app cliente | React Native + Expo SDK | MIT |
| Base de datos | PostgreSQL 16 + PostGIS | PostgreSQL / GPL |
| Tiempo real | Socket.IO | MIT |
| Diagramas | Mermaid / PlantUML | MIT / GPL |

## 2.2 Reemplazos de servicios comerciales

| Servicio comercial | Reemplazo open source | Licencia | Nota |
|---|---|---|---|
| AWS ECS Fargate | **Docker Compose** (opcional **k3s**) | Apache 2.0 | Laptop o servidor de la universidad. |
| CloudFront + ALB | **Caddy** | Apache 2.0 | Router, TLS automático, estáticos. |
| AWS WAF | **ModSecurity + OWASP CRS** | Apache 2.0 | Evidencia de OWASP Top 10. |
| RDS | PostgreSQL en contenedor + **pgBackRest** | MIT | Replicación nativa opcional. |
| ElastiCache Redis | **Valkey** | BSD-3 | Fork de Redis (Linux Foundation), compatible. |
| SQS | **BullMQ** sobre Valkey | MIT | Reintentos, backoff, diferidos, cron. Alternativa: RabbitMQ (MPL 2.0). |
| S3 | **SeaweedFS** (API S3) | Apache 2.0 | Se evita MinIO por recortes en su edición comunitaria en 2025. |
| Secrets Manager + KMS | **SOPS + age**; cifrado con **libsodium**; opcional **OpenBao** | MPL / BSD | Nunca versionar `.env` con secretos. |
| Google Maps (mapa) | **MapLibre GL JS / React Native** + **PMTiles** de OpenStreetMap | BSD / ODbL | Mapa de Ecuador en un archivo estático. |
| Google Maps (geocoding) | **Nominatim** (extracto Ecuador, Geofabrik) | GPL | No usar el Nominatim público con carga real. |
| Google Maps (rutas) | **OSRM** (o Valhalla) | BSD / MIT | Distancia real por calle para tarifa y ETA. |
| Búsqueda avanzada (V2) | **Meilisearch** | MIT | MVP con FTS de PostgreSQL. |
| GA4 | **Umami** o **Matomo** | MIT / GPL | Alineado con la LOPDP. |
| Email transaccional | **Nodemailer** + **Mailpit** | MIT | Mailpit captura correos para la demo. |
| Email marketing | **Listmonk** | AGPL | |
| Push (FCM) | **Web Push (VAPID)** + **ntfy** | MIT / Apache 2.0 | Sin Firebase. |
| Chat en vivo (V2) | **Chatwoot** (comunitaria) | MIT | |
| Observabilidad | **OpenTelemetry + Grafana + Prometheus + Loki + Tempo** (`grafana/otel-lgtm`) | Apache 2.0 / AGPL | |
| Disponibilidad | **Uptime Kuma** | MIT | |
| Repositorio y CI/CD | **Forgejo** + **Forgejo Actions** / **Woodpecker CI** | GPL / Apache 2.0 | |
| IaC | **OpenTofu** + **Ansible** | MPL / GPL | |
| Seguridad | **Trivy**, **OWASP ZAP**, **Semgrep CE** | Apache 2.0 / LGPL | |

## 2.3 Servicios externos sin equivalente open source → simuladores

| Integración | Situación | Solución |
|---|---|---|
| Datafast, Payphone, Medianet, DeUna, Banco Pichincha | Requieren registro como comercio. | Contenedor **`pasarela-simulada`**: página de pago falsa, aprobado/rechazado, **webhooks firmados HMAC**. Contra entrega y transferencia con comprobante funcionan sin proveedor. |
| SRI | Ambiente de pruebas gratuito, pero requiere RUC y firma `.p12` (con costo). | Generar XML real, clave de acceso de 49 dígitos (módulo 11) y firma XAdES con **certificado autofirmado** (OpenSSL). **`sri-simulado`** responde RECIBIDA/AUTORIZADO. Opcional: ambiente de pruebas real si alguien tiene RUC y firma. |
| Servientrega y otros couriers | API requiere convenio comercial. | **`courier-simulado`**: cotiza con `courier_rate_cards`, genera guía PDF y avanza estados automáticamente. |
| WhatsApp | API oficial cobra por mensaje; librerías no oficiales violan los términos de Meta. | `ChannelPort` con email, Web Push y ntfy. WhatsApp como adaptador simulado/documentado. |
| SMS | Siempre tiene costo. | Adaptador simulado (logs o Mailpit). |

## 2.4 Zona gris: gratis pero no open source (consultar con el profesor)

- **GitHub / GitHub Actions**: gratis en repos públicos, propietario. Alternativa: Forgejo.
- **Expo Go / EAS Build gratuito**: alternativa abierta `expo prebuild` + Android Studio.
- **Firebase Cloud Messaging**: solo necesario para push nativo en iOS.
- **Cloudflare Tunnel / capas gratuitas de nube**: alternativa abierta **frp** en servidor de la universidad.

## 2.5 Perfiles de Docker Compose

| Comando | Qué levanta | RAM aproximada |
|---|---|---|
| `docker compose up` | Núcleo | ~4-6 GB |
| `docker compose --profile maps up` | Núcleo + mapas | ~8-10 GB (Nominatim usa más RAM en la importación inicial) |
| `docker compose --profile maps --profile obs up` | Todo | ~12-16 GB |
| `docker compose up` (sidecar `pgbackrest`, siempre activo) | Backups diarios + WAL continuo; restaurar con `infra/pgbackrest/restore.sh` (ver `08-despliegue.md`) | — |

Ver `docker-compose.yml` e `infra/Caddyfile` en la raíz del proyecto.

## 2.6 Preparación de mapas (una sola vez)

```bash
# OSRM: descargar y preprocesar el extracto de Ecuador
cd infra/osrm
curl -LO https://download.geofabrik.de/south-america/ecuador-latest.osm.pbf
docker run --rm -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend osrm-extract -p /opt/car.lua /data/ecuador-latest.osm.pbf
docker run --rm -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend osrm-partition /data/ecuador-latest.osrm
docker run --rm -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend osrm-customize /data/ecuador-latest.osrm

# Tiles: extraer Ecuador desde un build de Protomaps con la CLI pmtiles
# pmtiles extract <build-protomaps>.pmtiles infra/tiles/ecuador.pmtiles --bbox=-81.1,-5.1,-75.1,1.7
```

Nominatim importa el extracto automáticamente la primera vez que arranca (puede tardar un buen rato).

## 2.7 Cifrado de secretos en columnas

Los campos `*_enc bytea` (TOTP, tokens de pago) se cifran en la aplicación con **libsodium** (`crypto_secretbox`) usando una clave maestra gestionada con SOPS. Reemplaza a KMS.
