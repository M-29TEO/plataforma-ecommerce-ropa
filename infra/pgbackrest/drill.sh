#!/usr/bin/env bash
# Simulacro de recuperación ante desastres: prueba restore.sh de punta a punta en un proyecto compose
# desechable (moda-drill). No toca la base de desarrollo: otros volúmenes, sin puertos publicados.
#
#   bash infra/pgbackrest/drill.sh                 (desde la raíz del repo; CI lo corre cada noche)
#   KEEP=1 bash infra/pgbackrest/drill.sh          (deja el proyecto levantado para inspeccionarlo)
#   DRILL_OFFSITE=0 bash infra/pgbackrest/drill.sh (sin el escenario 3 ni el S3 de backups)
#
# Escenario 1 — error humano (migración que borra datos): PITR al instante anterior al error.
# Escenario 2 — pérdida del disco de datos: se borra el volumen y se restaura al último WAL archivado.
# Escenario 3 — pérdida del servidor entero (datos Y backups locales): se restaura desde la copia
#               cifrada fuera del servidor (repo2 en S3 con HTTPS, deploy/compose.offsite.yml, como en prod).
# En cada uno se comprueba, fase por fase de una tabla testigo, que vuelva exactamente lo esperado.
set -euo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

cd "$(dirname "$0")/../.."
PROJECT="${DRILL_PROJECT:-moda-drill}"
OFFSITE="${DRILL_OFFSITE:-1}"
export PG_PASSWORD="drill-$(date +%s)"
# Variables que el compose interpola para otros servicios (no se levantan aquí): evitan avisos.
export PAYSIM_SECRET=drill COURIERSIM_SECRET=drill COURIERSIM_API_KEY=drill
COMPOSE="docker compose -p $PROJECT -f docker-compose.yml -f infra/pgbackrest/drill.override.yml"
if [ "$OFFSITE" = 1 ]; then
  export DRILL_S3_CERTS="${PROJECT}-s3certs"
  export BACKUP_S3_ENDPOINT=s3 BACKUP_S3_PORT=8333 BACKUP_S3_BUCKET=moda-backups
  export BACKUP_S3_KEY="AKDRILL$RANDOM" BACKUP_S3_KEY_SECRET="drill-s3-$(date +%s)-$RANDOM"
  export BACKUP_S3_CA_DIR=s3certs BACKUP_S3_CA_FILE=/etc/pgbackrest/s3/s3.crt
  export BACKUP_CIPHER_PASS="drill-cifrado-$(date +%s)-$RANDOM"
  COMPOSE="$COMPOSE -f deploy/compose.offsite.yml -f infra/pgbackrest/drill.offsite.yml"
fi
export COMPOSE
RESTORE="bash infra/pgbackrest/restore.sh --yes"

log() { echo; echo "=== [simulacro] $*"; }
fail() { echo "✗ SIMULACRO FALLIDO: $*" >&2; $COMPOSE logs --tail 80 postgres pgbackrest >&2 || true; exit 1; }
sql() { $COMPOSE exec -T postgres psql -U app -d moda -v ON_ERROR_STOP=1 -tAc "$1"; }
counts() { sql "select coalesce(string_agg(phase || '=' || n, ' ' order by phase), '(vacía)') from (select phase, count(*) n from drill.witness group by phase) t"; }
expect() {
  local got; got=$(counts)
  [ "$got" = "$1" ] || fail "se esperaba '$1' y hay '$got'"
  echo "✔ $got"
}
# Cierra el segmento de WAL en curso y espera a que archive-push lo deje en TODOS los repositorios.
archive_now() {
  sql "select pg_switch_wal()" >/dev/null
  for i in $(seq 1 30); do
    [ "$(sql "select coalesce(last_archived_wal, '') = pg_walfile_name(pg_current_wal_lsn() - 1) from pg_stat_archiver")" = t ] && return 0
    sleep 2
  done
  fail "el WAL no se archivó en 60 s"
}
cleanup() {
  [ "${KEEP:-0}" = 1 ] && return
  $COMPOSE down -v --remove-orphans >/dev/null 2>&1 || true
  [ "$OFFSITE" = 1 ] && docker volume rm "$DRILL_S3_CERTS" >/dev/null 2>&1 || true
}
trap cleanup EXIT

log "levantando postgres + pgbackrest (proyecto $PROJECT, copia fuera del servidor: $([ "$OFFSITE" = 1 ] && echo sí || echo no))"
cleanup
if [ "$OFFSITE" = 1 ]; then
  # Certificado autofirmado para "s3" (pgBackRest valida el TLS con él, como con una CA propia en
  # prod) y credenciales S3 del usuario de backups.
  docker volume create "$DRILL_S3_CERTS" >/dev/null
  docker run --rm -e AK="$BACKUP_S3_KEY" -e SK="$BACKUP_S3_KEY_SECRET" -v "$DRILL_S3_CERTS:/c" alpine:3.22 sh -c '
    apk add -q --no-cache openssl >/dev/null &&
    openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=s3" -addext "subjectAltName=DNS:s3" \
      -keyout /c/s3.key -out /c/s3.crt 2>/dev/null &&
    printf "{\"identities\":[{\"name\":\"pgbackrest\",\"credentials\":[{\"accessKey\":\"%s\",\"secretKey\":\"%s\"}],\"actions\":[\"Read\",\"Write\",\"List\",\"Tagging\",\"Admin\"]}]}" "$AK" "$SK" > /c/s3.json &&
    chmod 644 /c/*'
  $COMPOSE up -d s3
  # pgBackRest no crea el bucket: se crea una vez en el destino (en prod, infra/backup-host).
  for i in $(seq 1 30); do
    $COMPOSE exec -T s3 sh -c 'echo "s3.bucket.create -name moda-backups" | weed shell' 2>/dev/null | grep -q "created bucket" && break
    [ "$i" = 30 ] && fail "el S3 de backups no arrancó"
    sleep 2
  done
fi
$COMPOSE up -d --build --wait postgres
$COMPOSE up -d --no-deps pgbackrest

log "esperando el backup full inicial del sidecar (en cada repositorio)"
for i in $(seq 1 120); do
  if $COMPOSE exec -T pgbackrest test -f /var/lib/pgbackrest/last-ok 2>/dev/null; then break; fi
  [ "$i" = 120 ] && fail "el sidecar no hizo el full inicial en 4 min"
  sleep 2
done
$COMPOSE exec -T pgbackrest pgbackrest --stanza=moda info

log "datos de negocio y backup diferencial"
sql "create schema drill; create table drill.witness (id bigserial primary key, phase text not null, at timestamptz not null default clock_timestamp())"
sql "insert into drill.witness (phase) select 'a-antes-del-backup' from generate_series(1, 1000)"
$COMPOSE exec -T pgbackrest pgbackrest --stanza=moda backup --type=diff
sql "insert into drill.witness (phase) select 'b-despues-del-backup' from generate_series(1, 500)"
expect "a-antes-del-backup=1000 b-despues-del-backup=500"

# Instante objetivo del PITR: después de las 500 filas buenas y antes del "error".
sleep 2
TARGET=$(sql "select to_char(clock_timestamp() at time zone 'America/Guayaquil', 'YYYY-MM-DD HH24:MI:SS.US') || '-05'")
sleep 2

log "ESCENARIO 1: una migración mala borra datos (objetivo PITR: $TARGET)"
sql "insert into drill.witness (phase) select 'c-basura' from generate_series(1, 200); delete from drill.witness where phase = 'a-antes-del-backup'"
archive_now
expect "b-despues-del-backup=500 c-basura=200"
$RESTORE --target "$TARGET"
expect "a-antes-del-backup=1000 b-despues-del-backup=500"

log "ESCENARIO 2: se pierde el disco de datos (último WAL archivado)"
sql "insert into drill.witness (phase) select 'd-tras-el-pitr' from generate_series(1, 42)"
archive_now
$COMPOSE rm -f -s pgbackrest postgres >/dev/null
docker volume rm "${PROJECT}_pgdata" >/dev/null
echo "volumen ${PROJECT}_pgdata borrado"
$RESTORE
expect "a-antes-del-backup=1000 b-despues-del-backup=500 d-tras-el-pitr=42"

if [ "$OFFSITE" = 1 ]; then
  log "ESCENARIO 3: se pierde el servidor entero (datos y backups locales); queda la copia cifrada en S3"
  sql "insert into drill.witness (phase) select 'e-antes-de-perder-el-servidor' from generate_series(1, 7)"
  archive_now
  $COMPOSE rm -f -s pgbackrest postgres >/dev/null
  docker volume rm "${PROJECT}_pgdata" "${PROJECT}_pgbackrest" >/dev/null
  echo "volúmenes ${PROJECT}_pgdata y ${PROJECT}_pgbackrest (repo1) borrados"
  $RESTORE --repo 2
  expect "a-antes-del-backup=1000 b-despues-del-backup=500 d-tras-el-pitr=42 e-antes-de-perder-el-servidor=7"
  # El sidecar vuelve a crear repo1 vacío y le hace un full nuevo: la protección local se recupera sola.
  for i in $(seq 1 120); do
    $COMPOSE exec -T pgbackrest pgbackrest --stanza=moda --repo=1 info --output=json 2>/dev/null | grep -q '"label"' && break
    [ "$i" = 120 ] && fail "el sidecar no rehízo el full en repo1"
    sleep 2
  done
  echo "✔ repo1 recreado con un full nuevo"
fi

log "el archivado sigue funcionando tras restaurar"
$COMPOSE exec -T pgbackrest pgbackrest --stanza=moda check

echo
if [ "$OFFSITE" = 1 ]; then
  echo "✔ SIMULACRO OK: PITR tras error humano, disco de datos perdido y servidor perdido (desde la copia cifrada en S3)."
else
  echo "✔ SIMULACRO OK: PITR tras error humano y restauración completa con el volumen de datos perdido."
fi
