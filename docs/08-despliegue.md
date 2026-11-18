# Entregable 8 — Estrategia de despliegue: entornos, CI/CD, backups y DRP

Cómo pasa el código del repositorio a un servidor, cómo se protege la base de datos y qué hacer
cuando algo se pierde. Todo con herramientas open source y sin costo, y todo versionado en el repo
(infraestructura como código: archivos Compose, Caddyfiles, pipelines y scripts).

- **Fecha:** 2026-10-12.
- **Versión:** v0.6 (backend, storefront, backoffice y app del motorizado).
- **Alcance:** entornos dev, staging y prod con Docker Compose; pipeline de CI/CD (Woodpecker CI +
  Forgejo); backups de PostgreSQL con pgBackRest; plan de recuperación ante desastres (DRP); demo
  pública con frp.

| Pieza | Herramienta | Licencia | Dónde |
|---|---|---|---|
| Repositorio y registro de imágenes | **Forgejo** | GPL-3.0 | `infra/ci/compose.yml` |
| CI/CD | **Woodpecker CI** | Apache 2.0 | `.woodpecker/*.yml` |
| Lint | **ESLint** (typescript-eslint, eslint-config-next, eslint-config-expo) | MIT | `*/eslint.config.*` |
| Reglas de arquitectura | **dependency-cruiser** + `check-schemas.mjs` | MIT | `backend/.dependency-cruiser.cjs`, `backend/scripts/ci/` |
| Escaneo de vulnerabilidades | **Trivy** (repo e imágenes), **Semgrep** | Apache 2.0 / LGPL | `trivy.yaml`, `.semgrep.yml` |
| Backups y PITR | **pgBackRest** 2.59.1 | MIT | `infra/postgres/`, `infra/pgbackrest/` |
| Destino de la copia externa (S3) | **SeaweedFS** | Apache 2.0 | `infra/backup-host/` |
| TLS | **Caddy** + Let's Encrypt | Apache 2.0 | `deploy/Caddyfile.edge` |
| Túnel para la demo | **frp** v0.70.0 | Apache 2.0 | `infra/frp/`, `deploy/compose.demo.yml` |
| Despliegue por SSH | **drone-ssh** (plugin) | MIT | `.woodpecker/deploy-*.yml` |

## 8.1 Vista general

```
 push / PR ──► ci.yml ──────────────────────────────────────────────┐ (todo en paralelo)
               lint · typecheck · dependency-cruiser · schemas      │
               tests unitarios + integración (Testcontainers)       │
               storefront · backoffice · rider-app · simuladores    │
               Semgrep · Trivy del repo                             │
                                   │ verde                          │
 push a main / tag ──► images.yml (7 imágenes en paralelo)          │
               docker build ─► Trivy de la imagen ─► push al registro de Forgejo
                                   │ verde
 push a main ─────────► deploy-staging.yml ─► SSH: pull · migrate · up   (automático)
 tag vX.Y + "Deploy prod" ► deploy-prod.yml ─► SSH: backup · pull · migrate · up (manual)

 cada noche ──► nightly.yml: simulacro de restauración (3 escenarios) + Trivy del repo
```

Una imagen solo llega a un servidor si pasó todos los tests **y** Trivy no le encontró
vulnerabilidades HIGH o CRITICAL con parche. Prod solo recibe tags de git que ya corrieron en staging.

## 8.2 Entornos

### Diferencias

| | **dev** (PC del equipo) | **staging** | **prod** | **demo** (PC + frp) |
|---|---|---|---|---|
| Para qué | Programar y probar | Probar cada versión de `main` como si fuera prod | La tienda pública | Mostrar el proyecto sin servidor propio |
| Compose | `docker-compose.yml` | + `deploy/compose.server.yml` + `deploy/compose.staging.yml` | + `compose.server.yml` + `compose.prod.yml` + `compose.offsite.yml` | + `deploy/compose.demo.yml` |
| Imágenes | Se construyen en local (`--build`) | Del registro, `TAG=<sha>` de main | Del registro, `TAG=vX.Y.Z` | Se construyen en local |
| Despliegue | A mano | Automático en cada push a main | Manual, solo tags | A mano |
| HTTPS | No (`http://localhost`) | Sí, Let's Encrypt en `edge` | Sí, Let's Encrypt en `edge` | Sí, en el Caddy del servidor frps |
| Puertos publicados | Todos (5432, 6379, 8025...) para depurar | Solo 80/443 | Solo 80/443 | Ninguno: túnel saliente |
| Mailpit / Grafana / Kuma | `localhost` | Solo `127.0.0.1` (túnel SSH) | Solo `127.0.0.1` (túnel SSH) | `localhost` |
| Correo | Mailpit | Mailpit: nunca sale a clientes | SMTP de la institución (`SMTP_URL`) | Mailpit |
| Buscadores | — | `X-Robots-Tag: noindex` | Indexable | — |
| Backups | repo1 (volumen local) | repo1 | repo1 + **repo2 cifrado fuera del servidor** | repo1 |
| Límites de memoria y logs rotados | No | Sí (PostgreSQL 1 GB) | Sí (PostgreSQL 2 GB) | No |
| Pasarela, SRI y courier | Simuladores | Simuladores | Simuladores (no hay proveedor real sin costo) | Simuladores |
| Secretos | `.env` local | `.env` propio (distinto de prod) | `.env` propio | `.env` local + `FRP_*` |

Las capas de Compose se suman y cada una solo cambia lo que difiere. `compose.server.yml` reemplaza
`build` por `image` del registro con `!reset`, cierra los puertos de datos y agrega el borde con TLS
(`edge`). Por eso los tres entornos comparten la misma definición de servicios, healthchecks y
dependencias de `docker-compose.yml`.

```
Internet ─443─► edge (Caddy, TLS) ─► waf (ModSecurity + OWASP CRS) ─► caddy ─┬─► api / realtime
                                                                              ├─► web (storefront)
                └─ pagos.<dominio> ─► pasarela-simulada                       └─► backoffice (/admin)
                └─ ntfy.<dominio>  ─► ntfy (app del motorizado)
```

### dev

Sin cambios respecto de lo que ya describen el README y `docs/02-stack-open-source.md`:

```bash
docker compose up -d                       # postgres (+ sidecar de backups), valkey, seaweedfs, mailpit, ntfy
docker compose --profile front --profile backoffice --profile sims up -d --build   # tienda completa
```

Lo nuevo en dev es que `postgres` usa la imagen `infra/postgres` (la misma PostGIS 16-3.4 con
parches y pgBackRest) y que el sidecar `pgbackrest` archiva los WAL y hace un backup diario. La
primera vez que se levanta sobre una base existente, el sidecar crea la stanza y hace un full. Los
datos no cambian: es la misma versión mayor de PostgreSQL y de PostGIS.

### staging y prod: preparar el servidor (una vez)

Requisitos: Linux con Docker Engine y el plugin Compose (v2.24 o superior, por `!reset`), un usuario
`deploy` en el grupo `docker` y DNS apuntando al servidor (dominio de la tienda y los subdominios
`pagos.` y `ntfy.`).

```bash
# Como deploy, en el servidor. Ejemplo para prod (staging: moda-staging y env.staging.example)
sudo mkdir -p /opt/moda-prod && sudo chown deploy: /opt/moda-prod
git clone https://git.miuniversidad.edu.ec/moda/moda-ecommerce.git /opt/moda-prod
cd /opt/moda-prod
cp deploy/env.prod.example .env && chmod 600 .env
# Completar .env: dominios, secretos (openssl rand -base64 48 / 32), SMTP_URL, BACKUP_* ...
# El .env fija COMPOSE_FILE y COMPOSE_PROFILES: desde aquí basta "docker compose ...".

# Firma electrónica del SRI (nunca al repo)
bash backend/scripts/generate-sri-cert.sh              # o copiar la firma real a backend/secrets/sri
# Solo si el S3 de backups usa un certificado propio (no Let's Encrypt): su CA aquí y
# BACKUP_S3_CA_FILE=/etc/pgbackrest/s3/ca.crt en el .env
mkdir -p deploy/secrets/s3

# Registro de imágenes (token de Forgejo con read:package)
docker login git.miuniversidad.edu.ec

docker compose pull
docker compose run --rm migrate                         # migraciones
docker compose up -d --wait
```

**Host de backups** (`infra/backup-host/`): SeaweedFS con S3 detrás de Caddy (HTTPS con Let's
Encrypt). Puede ser el servidor de la universidad, un PC del laboratorio o un NAS con Docker, pero
**no** el mismo servidor de prod. El puerto 443 se abre solo a la IP de prod.

```bash
cd infra/backup-host && cp env.example .env   # dominio y BACKUP_S3_KEY / BACKUP_S3_KEY_SECRET (iguales que en prod)
docker compose up -d
docker compose exec seaweedfs sh -c 'echo "s3.bucket.create -name moda-backups" | weed shell'
```

Ese host nunca ve datos en claro: pgBackRest cifra con `BACKUP_CIPHER_PASS` antes de enviar.

Después, cada despliegue lo hace Woodpecker (8.3). A mano sería:

```bash
cd /opt/moda-prod && git fetch --tags && git checkout v1.2.0
sed -i 's/^TAG=.*/TAG=v1.2.0/' .env
docker compose pull && docker compose run --rm migrate && docker compose up -d --wait
```

**Rollback:** `TAG=<versión anterior>` y `docker compose up -d`. Las migraciones de `node-pg-migrate`
son solo hacia adelante en prod. Si una migración rompió datos, la vuelta atrás es un PITR (8.6,
escenario 1).

### Ver Grafana, Uptime Kuma o Mailpit en un servidor

En servidores esos paneles escuchan solo en `127.0.0.1`. Se ven con un túnel SSH:

```bash
ssh -L 3001:127.0.0.1:3001 -L 3002:127.0.0.1:3002 -L 8025:127.0.0.1:8025 deploy@tienda.miuniversidad.edu.ec
# y en el navegador: http://localhost:3001 (Grafana), :3002 (Uptime Kuma), :8025 (Mailpit)
```

## 8.3 Pipeline de CI/CD (Woodpecker CI + Forgejo)

Se eligió **Woodpecker** sobre Forgejo Actions:

- su YAML es corto y propio, y cada paso es un contenedor;
- la matriz de imágenes y las dependencias entre workflows (`depends_on`) vienen de serie;
- no necesita un runner aparte con la compatibilidad de GitHub Actions.

Forgejo aporta el repositorio, el login (OAuth) y el **registro de contenedores** (Packages).

### Workflows (`.woodpecker/`)

| Archivo | Cuándo | Qué hace | Si falla |
|---|---|---|---|
| `ci.yml` | push, PR, manual | **Lint** (ESLint en backend, storefront, backoffice y rider-app) y typecheck · **dependency-cruiser** (`npm run arch:check`) y **schemas** (`npm run arch:schemas`) · tests unitarios del backend · tests de integración (Testcontainers: PostGIS y Valkey desechables) · Vitest (storefront, backoffice), Jest (rider-app), `node --test` (simuladores) · **Semgrep** · **Trivy** del repo | No se construyen imágenes |
| `images.yml` | push a main, tags, manual (después de `ci`) | Matriz de 7 imágenes (`api`, `web`, `backoffice`, `postgres`, los 3 simuladores): `docker build` → **Trivy de la imagen** (HIGH/CRITICAL con parche: falla) → push con tags `<sha8>`, `main` y `vX.Y.Z` | La imagen no se publica |
| `deploy-staging.yml` | push a main (después de `images`) | SSH al servidor: fija `TAG=<sha8>`, `pull`, `migrate`, `up --wait` | Staging sigue en la versión anterior |
| `deploy-prod.yml` | evento *deployment* con destino `prod` | Verifica que sea un tag; SSH: **backup diferencial previo**, `pull`, `migrate`, `up --wait` | Prod sigue en la versión anterior |
| `nightly.yml` | cron `nightly` (02:00 Ecuador), manual | **Simulacro de restauración** (8.6) + Trivy del repo (CVE nuevos en dependencias que no cambiaron) | Alerta: los backups no se pueden restaurar |

Los pasos de `ci.yml` corren en paralelo, salvo la integración, que espera a los tests unitarios.
Los resultados quedan en la interfaz de Woodpecker y Forgejo marca el commit o el PR en verde o en
rojo.

### Reglas de arquitectura en CI

`docs/01-arquitectura-c4.md` fija cuatro reglas de modularidad. Ahora se verifican en cada push:

| Regla | Cómo se revisa |
|---|---|
| 1. Un módulo solo importa el `index.ts` de otro | dependency-cruiser `solo-index-de-otro-modulo` y `apps-solo-por-index`. Excepción: `events.ts`, los contratos de eventos (nombres y payloads, sin Nest ni base) |
| Sin ciclos entre módulos | `sin-ciclos-entre-modulos` |
| Hexagonal: el dominio no depende de application/api/infrastructure; los casos de uso no dependen de adaptadores | `dominio-puro`, `aplicacion-sin-infraestructura` |
| El shared kernel no conoce módulos; el código de producción no importa devDependencies | `shared-kernel-no-depende-de-modulos`, `produccion-sin-dev-dependencies` |
| 2. Un módulo solo usa sus tablas (salvo Reportes) | `scripts/ci/check-schemas.mjs`: busca `FROM/JOIN/INTO/UPDATE schema.tabla` en el código de cada módulo contra un mapa de dueños (`sales` se reparte por tabla entre carrito, pedidos y promociones; `platform`, entre shared kernel y notificaciones) |

Al activarlo, dependency-cruiser encontró un **ciclo real Pedidos ↔ Pagos**. Cada consumidor de
eventos importaba las constantes del `index.ts` del otro módulo, y ese `index.ts` carga el módulo
Nest entero. Se corrigió agregando `orders/events.ts` y `payments/events.ts`, que son contratos de
eventos sin dependencias; los consumidores importan de ahí. Para verificar que las reglas detectan
violaciones, se agregaron importaciones prohibidas a propósito: el CI las detectó todas.

### Montar Forgejo + Woodpecker (laboratorio o servidor de la universidad)

```bash
cd infra/ci && cp env.example .env       # FORGE_HOST, WOODPECKER_AGENT_SECRET=$(openssl rand -hex 32)
docker compose up -d forgejo
# 1. http://<FORGE_HOST>:3000 → crear la cuenta (la primera es admin), la organización "moda" y el repo.
# 2. Configuración > Aplicaciones > OAuth2: "Woodpecker", redirect http://<FORGE_HOST>:8000/authorize
#    → copiar client id/secret a WOODPECKER_FORGEJO_CLIENT/SECRET; WOODPECKER_ADMIN=<tu usuario>.
docker compose up -d
# 3. http://<FORGE_HOST>:8000 → login con Forgejo → activar el repo.
#    Settings > Project: marcar "Trusted" > volumes (Testcontainers, build de imágenes y el simulacro
#    usan el Docker del agente).
#    Settings > Secrets: registry, registry_user, registry_token, public_site_url,
#                        staging_host, prod_host, deploy_user, deploy_ssh_key
#    Settings > Cron: "nightly", 0 7 * * *  (UTC = 02:00 en Ecuador)
git remote add forgejo http://<FORGE_HOST>:3000/moda/moda-ecommerce.git && git push forgejo main --tags
```

Para usar el registro desde `localhost`, `registry=localhost:3000`: Docker solo acepta registros HTTP
sin TLS en `localhost`. En un servidor con dominio, Forgejo va detrás de Caddy con HTTPS.

**Probar un workflow sin servidor** (lo que se hizo para validar esta entrega):

```bash
docker run --rm -v "$PWD/.woodpecker:/w:ro" woodpeckerci/woodpecker-cli:v3 lint /w      # sintaxis
# Ejecutar nightly.yml como lo haría el agente (el workspace debe ser una ruta del host de Docker):
docker run --rm --user 0 -v /tmp/wpsrc:/tmp/wpsrc -v /var/run/docker.sock:/var/run/docker.sock \
  woodpeckerci/woodpecker-cli:v3 exec --local --repo-path /tmp/wpsrc --repo-trusted-volumes \
  --pipeline-event manual /tmp/wpsrc/.woodpecker/nightly.yml
```

El workflow de GitHub (`.github/workflows/security.yml`) sigue igual, para cuando el repo se
refleja en GitHub.

### Desplegar a prod

```bash
git tag -a v1.0.0 -m "Primera versión pública" && git push forgejo v1.0.0   # ci + images publican :v1.0.0
# Verificar en staging; luego, en Woodpecker, en el pipeline del tag: botón "Deploy" → destino "prod".
# O por consola:
woodpecker-cli deploy moda/moda-ecommerce <n.º del pipeline del tag> prod
```

## 8.4 Backups

### Qué se respalda

| Dato | Cómo | Dónde | Frecuencia |
|---|---|---|---|
| **PostgreSQL** (todo el negocio: pedidos, pagos, facturas, clientes, auditoría) | pgBackRest: archivado continuo de WAL + backups full y diferenciales, comprimidos con zstd | repo1: volumen `pgbackrest` del servidor. repo2 (prod): S3 con HTTPS en otro host (`infra/backup-host`), **cifrado AES-256** antes de salir | WAL: continuo (como mucho 60 s, `archive_timeout`). Full: domingos. Diferencial: los demás días, a las 02:00 |
| Objetos de SeaweedFS (fotos de productos y devoluciones, XML y RIDE del SRI, comprobantes, exportes) | Réplica del filer con `weed filer.backup` hacia otro destino (ver "Pendiente") | Mismo host de backups | Continuo |
| Valkey (colas BullMQ, sesiones de rate limit, anti-replay del 2FA) | **No se respalda**: es reconstruible. Los efectos entre módulos viven en `platform.outbox_events` (PostgreSQL) y el relay los vuelve a encolar | — | — |
| Secretos (`.env` con las credenciales S3 y `BACKUP_CIPHER_PASS`, firma del SRI, `deploy/secrets/`) | Copia **offline** en un gestor de contraseñas (KeePassXC) de dos responsables | Fuera de cualquier servidor | En cada cambio |
| Configuración (Compose, Caddy, pipelines) | Es el repositorio git | Forgejo + clones del equipo | Cada commit |

Sin `BACKUP_CIPHER_PASS`, repo2 no se puede leer. Esa clave se guarda fuera del servidor: si el
servidor se pierde, también se pierde el `.env`.

### Cómo funciona (`infra/postgres/`)

- **Imagen** `infra/postgres/Dockerfile`: es `postgis/postgis:16-3.4` con los últimos parches
  publicados para su base (Debian 11 y PostgreSQL 16.x). Agrega pgBackRest 2.59.1 con versión fija,
  arranca como `postgres` (no root) y trae `archive_mode=on` y
  `archive_command='pgbackrest --stanza=moda archive-push %p'`.
- **Sidecar `pgbackrest`** (`backup-loop.sh`): usa la misma imagen y comparte con postgres los
  datos, el socket y el repositorio. Al arrancar hace esto:
  1. espera a la base;
  2. crea la stanza (es idempotente) y ejecuta `check` para comprobar que el archivado funciona;
  3. si un repositorio no tiene backups, hace un full en ese momento.

  Después espera a `BACKUP_HOUR` cada día. Si un backup falla, avisa al tópico ntfy de operación,
  el mismo de Grafana y Uptime Kuma.
- **Healthcheck:** el sidecar figura `unhealthy` si no hubo un backup bueno en 26 h. Uptime Kuma lo
  puede vigilar como monitor de "Docker container".
- **Retención:** repo1 guarda 4 full, unas 4 semanas de PITR. repo2 guarda 8 full
  (`BACKUP_REPO2_RETENTION_FULL`). pgBackRest borra los WAL que ya no sirven a ningún backup retenido.

```bash
docker compose exec pgbackrest pgbackrest --stanza=moda info               # backups y rango de WAL
docker compose exec pgbackrest pgbackrest --stanza=moda backup --type=full # backup manual
docker compose logs -f pgbackrest
```

## 8.5 Restauración: `infra/pgbackrest/restore.sh`

```bash
bash infra/pgbackrest/restore.sh --info                              # qué hay para restaurar
bash infra/pgbackrest/restore.sh                                     # al último WAL archivado
bash infra/pgbackrest/restore.sh --target "2026-10-12 10:30:00-05"   # PITR: justo antes del error
bash infra/pgbackrest/restore.sh --set 20261011-020001F              # un backup concreto
bash infra/pgbackrest/restore.sh --repo 2 --backup                   # desde la copia externa + full nuevo
```

El script hace lo siguiente:

1. Muestra los backups disponibles y pide escribir `RESTAURAR` (`--yes` en scripts).
2. Detiene la API, el worker, el realtime, el sidecar y postgres.
3. Restaura con `pgbackrest restore --delta`, que copia solo lo que cambió. Con `--target`, prepara
   un PITR con `target-action=promote`.
4. Arranca postgres, que aplica los WAL con `archive-get` hasta el objetivo, y espera a que salga de
   la recuperación.
5. Vuelve a levantar solo los servicios que estaban corriendo.

Funciona aunque el volumen de datos esté vacío o borrado: el contenedor de restauración llena el
volumen antes de que postgres arranque, así que no corre `initdb`. Usa el `docker compose` del
directorio. Para otro proyecto se pasa `COMPOSE="docker compose -p ... -f ..."`.

### Simulacro: el script de restauración está probado

`infra/pgbackrest/drill.sh` prueba la restauración de punta a punta en un proyecto Compose
desechable (`moda-drill`, con volúmenes propios y sin puertos publicados). Usa los servicios
**reales** de `docker-compose.yml` y la capa **real** de prod para repo2 (`deploy/compose.offsite.yml`)
contra un SeaweedFS S3 desechable con HTTPS (certificado verificado contra su CA). En cada paso
cuenta las filas de una tabla testigo, fase por fase:

| Escenario | Qué se rompe | Restauración | Se comprueba |
|---|---|---|---|
| 1. Error humano | Una "migración" inserta basura y borra 1000 filas | `restore.sh --target <instante previo>` (PITR) | Vuelven las 1000 filas, se mantienen las 500 posteriores al backup y desaparece la basura |
| 2. Disco de datos perdido | Se borra el volumen `pgdata` | `restore.sh` (último WAL) | Está todo, incluidas las filas escritas tras el PITR (cruza dos cambios de línea de tiempo) |
| 3. Servidor perdido | Se borran `pgdata` **y** el repo1 local | `restore.sh --repo 2` (copia cifrada en S3) | Está todo hasta el último WAL archivado; el sidecar recrea repo1 y le hace un full nuevo |
| Al final | — | `pgbackrest check` | El archivado sigue funcionando |

```bash
bash infra/pgbackrest/drill.sh                 # 3 a 7 min; KEEP=1 deja el proyecto para inspeccionarlo
DRILL_OFFSITE=0 bash infra/pgbackrest/drill.sh # solo escenarios 1 y 2
```

Resultados de esta entrega (Docker Desktop en Windows, base de unos 60 MB):

- en la máquina del equipo, los 3 escenarios en verde (unos 7 min, casi todo en arrancar
  contenedores sobre OneDrive);
- dentro de un paso de Woodpecker (`woodpecker-cli exec` con `nightly.yml`), los 3 escenarios en
  verde en unos 2,5 min;
- cada restauración tarda unos segundos y la recuperación de postgres, menos de 5 s.

Lo que el simulacro encontró antes de llegar a prod:

- **repo2 por SFTP no funcionaba contra ningún OpenSSH actual.** La libssh2 1.9 de la imagen
  (Debian 11, compilada con libgcrypt) no negocia curve25519 ni ECDH y solo firma con `ssh-rsa`
  (SHA-1). OpenSSH 8.8 y posteriores lo rechazan por defecto, y OpenSSH 10 ya no ofrece
  Diffie-Hellman clásico. Por eso repo2 usa S3 sobre HTTPS: pgBackRest trae su propio cliente con
  OpenSSL.
- pgBackRest con SFTP exigía además `repo-sftp-host-key-hash-type`.
- La imagen original `postgis/postgis:16-3.4` tenía 93 vulnerabilidades HIGH/CRITICAL con parche y
  PostgreSQL 16.4. La imagen `infra/postgres` queda en 0 y en PostgreSQL 16.15.

`nightly.yml` repite el simulacro cada noche: un backup que nunca se restauró no cuenta como backup.

## 8.6 Plan de recuperación ante desastres (DRP)

### Objetivos

| | Objetivo | Por qué es alcanzable |
|---|---|---|
| **RPO** (datos que se pueden perder) | ≤ 1 minuto con el servidor vivo; ≤ 1 minuto con el servidor perdido (prod con repo2) | Cada WAL se copia a los dos repositorios al cerrarse, y `archive_timeout=60` cierra uno por minuto aunque haya poco tráfico |
| **RTO** (tiempo hasta volver a vender) | ≤ 30 min con el servidor vivo; ≤ 4 h con el servidor perdido | Restaurar la base de la demo toma segundos (simulacro). El resto es decidir, avisar y, si se perdió el host, preparar otro (8.2) |

### Roles

| Rol | Quién | Qué hace |
|---|---|---|
| Responsable del incidente | Líder técnico del equipo | Declara el incidente, elige el escenario y autoriza la restauración |
| Operador | Quien tenga acceso SSH y el `.env` | Ejecuta el runbook |
| Comunicación | Responsable del producto | Avisa al personal (ntfy) y a los clientes afectados |
| Custodios de secretos | Dos personas | Guardan la copia offline de `.env`, `BACKUP_CIPHER_PASS` y las llaves |

### Runbooks

**Escenario 1: error humano o migración mala** (datos borrados o corruptos, servidor sano)

1. Detener las escrituras: `docker compose stop api worker realtime`. El storefront queda con error y
   Uptime Kuma avisa.
2. Encontrar el instante del error en los logs de la API (Grafana → Loki), en `platform.audit_log` o
   con la hora del despliegue en Woodpecker.
3. `bash infra/pgbackrest/restore.sh --target "<instante un poco antes>-05" --backup`.
4. Revisar que los datos estén bien antes de reabrir. Si el objetivo quedó corto o largo, repetir:
   el repositorio conserva todos los WAL de antes del PITR.
5. Si fue una migración: volver a la imagen anterior (`TAG=`) antes de arrancar la API.
6. Pérdida: lo escrito entre el error y la restauración. Si son pedidos o pagos, la pasarela y el SRI
   tienen su propio registro para conciliar.

**Escenario 2: disco de datos dañado o volumen borrado** (servidor sano)

1. `docker compose stop` y revisar el disco (`dmesg`, `smartctl`). Si falla, cambiarlo o mover el
   volumen.
2. `bash infra/pgbackrest/restore.sh --backup`, que restaura al último WAL archivado (pérdida
   ≤ 1 minuto).
3. Comprobar `/v1/health`, el dashboard "Moda · Operación" y un pedido de prueba.

**Escenario 3: servidor perdido** (robo, incendio, falla total, cuenta comprometida)

1. Preparar un host nuevo como en 8.2: Docker, clon del repo, `.env` desde la copia offline, firma
   del SRI (y la CA del S3 de backups, si es propia) también desde la copia offline.
2. `docker compose pull`, sin `up` todavía.
3. `bash infra/pgbackrest/restore.sh --repo 2 --backup`. Restaura desde la copia cifrada del host de backups; el
   sidecar recrea repo1 solo.
4. Restaurar los objetos de SeaweedFS desde su réplica (ver "Pendiente").
5. `docker compose run --rm migrate` (no debería haber pendientes), `docker compose up -d --wait`.
6. Apuntar el DNS a la IP nueva. Caddy obtiene los certificados solo.
7. Pérdida: ≤ 1 minuto de datos más lo que no estaba replicado en SeaweedFS.

**Escenario 4: credenciales o servidor comprometidos**

1. Aislar: cortar el acceso público (`docker compose stop edge`) y conservar el disco para analizarlo.
2. Rotar todos los secretos: JWT y llaves de cifrado (todas las sesiones se cierran), tokens de
   Forgejo y Woodpecker, llaves SSH de despliegue y de backups, y `FRP_TOKEN`.
3. Restaurar en un host limpio (escenario 3), con un PITR al instante anterior a la intrusión si
   hubo manipulación de datos.
4. LOPDP: si se expusieron datos personales, notificar a la Autoridad y a los titulares en el plazo
   legal (ver `docs/07-seguridad.md`).

**Escenario 5: falla de Valkey o SeaweedFS**

- Valkey: `docker compose up -d valkey`. Si el volumen se dañó, borrarlo y levantarlo vacío. Las colas
  se rehacen desde el outbox de PostgreSQL. Los clientes pueden tener que volver a iniciar sesión
  según el estado del rate limit y del 2FA.
- SeaweedFS: restaurar desde su réplica. Mientras tanto, las fotos y los PDF devuelven 404, pero el
  negocio sigue.

### Calendario de pruebas

| Qué | Cuándo | Quién |
|---|---|---|
| Simulacro automático (3 escenarios) | Cada noche (`nightly.yml`) | Woodpecker |
| Restauración real en staging desde el backup de prod más reciente (repo2) | Una vez por mes | Operador |
| Ensayo completo del escenario 3 en un host nuevo, cronometrado | Antes de cada entrega del proyecto | Equipo |
| Revisar que la copia offline de secretos abre y está al día | Cada 3 meses | Custodios |

## 8.7 Exponer la demo con frp

Para mostrar la tienda funcionando desde la laptop o un PC del laboratorio, sin IP pública, sin
abrir puertos en el router y sin Cloudflare Tunnel ni ngrok, que son servicios de terceros.
**frp** abre un túnel **saliente** desde el PC hasta un servidor de la universidad que sí tiene IP
pública.

```
 navegador ─https─► Caddy (TLS) ─► frps:8080 ═══ túnel TLS + token (7000) ═══ frpc ─┬─► waf:8080 (tienda)
              servidor de la universidad                        PC de la demo        ├─► pasarela-simulada:3000
                                                                                     └─► ntfy:80
```

Son tres dominios porque la pasarela simulada (la página de pago la abre el navegador) y ntfy (lo
usa la app del motorizado) tienen que ser accesibles desde fuera, no solo la tienda.

**1. Servidor de la universidad** (una vez). Hacen falta Docker y un DNS con los tres nombres
apuntando a su IP. En el firewall se abren 80, 443 y 7000.

```bash
cd infra/frp/server && cp env.example .env
# FRP_TOKEN=$(openssl rand -base64 32), FRP_DEMO_DOMAIN=demo.moda.miuniversidad.edu.ec,
# FRP_PAYSIM_DOMAIN=pagos.demo..., FRP_NTFY_DOMAIN=ntfy.demo..., ACME_EMAIL=...
docker compose up -d
```

**2. PC de la demo.** En el `.env` de la raíz:

```bash
FRP_SERVER_ADDR=frp.miuniversidad.edu.ec
FRP_TOKEN=<el mismo del servidor>
FRP_DEMO_DOMAIN=demo.moda.miuniversidad.edu.ec
FRP_PAYSIM_DOMAIN=pagos.demo.moda.miuniversidad.edu.ec
FRP_NTFY_DOMAIN=ntfy.demo.moda.miuniversidad.edu.ec
```

```bash
docker compose -f docker-compose.yml -f deploy/compose.demo.yml \
  --profile front --profile backoffice --profile sims --profile demo up -d --build
docker compose -f docker-compose.yml -f deploy/compose.demo.yml logs frpc   # "start proxy success" ×3
```

`compose.demo.yml` agrega `frpc` y cambia las URLs que ven el navegador y el teléfono:

- `PAYSIM_PUBLIC_URL`, `PAYMENT_RETURN_URL`, `STOREFRONT_URL` y `NTFY_PUBLIC_URL` pasan a los
  dominios públicos;
- `NEXT_PUBLIC_SITE_URL` del storefront también, por eso hace falta `--build`.

La tienda sigue disponible en `http://localhost` para el equipo.

**Seguridad:**

- frpc se autentica con un token y el canal va cifrado (`transport.tls.force` en frps);
- un token incorrecto se rechaza;
- solo se publican los tres servicios: ni Postgres, ni Grafana, ni Mailpit, ni el backoffice
  directo (el backoffice entra por el WAF en `/admin`, con 2FA);
- todo el tráfico pasa por el WAF, igual que en local;
- al terminar la demo: `docker compose ... stop frpc`.

**Verificado en esta entrega:** frps y frpc v0.70.0, con estos `.toml`, en una red Docker aislada:

- cada dominio llegó a su servicio;
- un dominio desconocido respondió 404;
- un cliente con token incorrecto fue rechazado.

## 8.8 Riesgos conocidos y pendientes

| Riesgo o pendiente | Impacto | Mitigación actual / siguiente paso |
|---|---|---|
| `postgis/postgis:16-3.4` usa **Debian 11, sin soporte** desde 2026 | Los CVE nuevos del sistema base ya no tendrán parche | La imagen aplica los últimos parches publicados (de `archive.debian.org`) y Trivy de la imagen bloquea los HIGH/CRITICAL con parche. Siguiente paso: pasar a una etiqueta de PostGIS sobre Debian 12 o 13 (misma versión mayor 16; requiere `ALTER EXTENSION postgis UPDATE`) y actualizar también la imagen de Testcontainers |
| **SeaweedFS sin respaldo automatizado** | Perder el host pierde fotos y documentos del SRI (que deben conservarse 7 años) | Ahora: réplica manual con `weed filer.backup` o `rclone sync` hacia el mismo host de backups (su S3). Siguiente paso: un sidecar como el de pgBackRest |
| `NEXT_PUBLIC_SITE_URL` se fija al construir la imagen del storefront | Staging y prod comparten la imagen, así que staging tiene canónicas de prod | Staging lleva `noindex`. Siguiente paso: leer la URL en tiempo de ejecución en el servidor |
| Un solo servidor por entorno | Una caída del host deja la tienda fuera hasta restaurar (RTO 4 h) | Aceptado para el proyecto. Siguiente paso: réplica en espera de PostgreSQL (`pgbackrest` + streaming) |
| Los tests de integración y el simulacro necesitan el Docker del agente | Un repo *Trusted* puede montar el socket de Docker | Solo los administradores marcan repos como Trusted; el agente corre en un host dedicado al CI |
| Si el host de backups se cae, `archive-push` falla para repo2 | PostgreSQL reintenta y guarda los WAL en `pg_wal` hasta que repo2 vuelve: el disco del servidor puede llenarse si la caída dura días | Según la documentación de pgBackRest, repo1 sigue recibiendo cada WAL (empuja a los repos que respondan y solo reporta el error) y el sidecar avisa por ntfy si falla un backup. Siguiente paso: alerta en Grafana sobre `pg_stat_archiver.failed_count` y el tamaño de `pg_wal` |
| `trivy.yaml` declaraba un escáner `docker-compose` que Trivy no tiene | Trivy lo ignoraba y usaba los escáneres por defecto | Corregido: `scanners: [dockerfile]` |

## 8.9 Cómo probar esta entrega

```bash
# Lint y reglas de arquitectura (backend)
cd backend && npm ci && npm run lint && npm run typecheck && npm run arch:check && npm run arch:schemas
# Lint de los frontends
(cd storefront && npm run lint) ; (cd backoffice && npm run lint) ; (cd rider-app && npm run lint)

# Workflows de Woodpecker: sintaxis
docker run --rm -v "$PWD/.woodpecker:/w:ro" woodpeckerci/woodpecker-cli:v3 lint /w

# Backups: simulacro completo (proyecto desechable, no toca la base de desarrollo)
bash infra/pgbackrest/drill.sh

# Entornos: que las capas de Compose resuelvan (en una copia con un .env de ejemplo)
cp deploy/env.prod.example /tmp/x/.env && cp -r docker-compose.yml deploy /tmp/x/ && (cd /tmp/x && docker compose config -q)
```
