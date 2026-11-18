#!/usr/bin/env bash
# Restauración de PostgreSQL desde pgBackRest (docs/08-despliegue.md, "Plan de recuperación ante desastres").
#
#   bash infra/pgbackrest/restore.sh                                   # al último WAL archivado
#   bash infra/pgbackrest/restore.sh --target "2026-10-12 10:30:00-05" # PITR: justo antes del error
#   bash infra/pgbackrest/restore.sh --set 20261011-020001F             # un backup concreto, sin WAL extra
#   bash infra/pgbackrest/restore.sh --info                             # solo listar backups
#
# Opciones: --repo 2 (restaurar desde la copia fuera del servidor), --yes (sin preguntar),
#           --backup (full nuevo al terminar; recomendado tras un PITR).
#
# Entornos: usa `docker compose` del directorio actual. Para staging/prod o el simulacro, pasa el
# comando completo en COMPOSE, por ejemplo:
#   COMPOSE="docker compose -f docker-compose.yml -f deploy/compose.prod.yml --env-file .env.prod" \
#     bash infra/pgbackrest/restore.sh --target "..."
#
# Funciona también con el volumen de datos vacío o borrado (servidor nuevo): el contenedor de
# restauración lo crea y pgBackRest lo llena antes de que postgres arranque, así no corre initdb.
set -euo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'   # Git Bash en Windows: no convertir rutas

COMPOSE="${COMPOSE:-docker compose}"
STANZA=moda
APP_SERVICES="api worker realtime"   # los que escriben en la base: se detienen durante la restauración

target="" set="" repo="" yes=0 info_only=0 backup_after=0
while [ $# -gt 0 ]; do
  case "$1" in
    --target) target="$2"; shift 2 ;;
    --set) set="$2"; shift 2 ;;
    --repo) repo="$2"; shift 2 ;;
    --yes|-y) yes=1; shift ;;
    --info) info_only=1; shift ;;
    --backup) backup_after=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "opción desconocida: $1" >&2; exit 2 ;;
  esac
done
[ -n "$target" ] && [ -n "$set" ] && { echo "usa --target o --set, no ambos" >&2; exit 2; }

log() { echo "[restore] $*"; }
# Contenedor desechable con la imagen y los volúmenes del sidecar (no depende de que postgres corra).
pgbr() { $COMPOSE run --rm --no-deps -T pgbackrest pgbackrest --stanza="$STANZA" "$@"; }
psql_q() { $COMPOSE exec -T postgres psql -U app -d moda -tAc "$1"; }

repo_opt=()
[ -n "$repo" ] && repo_opt=(--repo="$repo")

log "backups disponibles:"
pgbr "${repo_opt[@]}" info
[ "$info_only" = 1 ] && exit 0

restore_opts=(--delta "${repo_opt[@]}")
if [ -n "$target" ]; then
  # target-action=promote: al llegar al instante pedido, la base queda abierta en una línea de tiempo nueva.
  restore_opts+=(--type=time "--target=$target" --target-action=promote)
  what="al instante $target"
elif [ -n "$set" ]; then
  restore_opts+=("--set=$set" --type=immediate --target-action=promote)
  what="al backup $set (sin aplicar WAL posteriores)"
else
  what="al último WAL archivado"
fi

if [ "$yes" != 1 ]; then
  echo
  echo "Se va a RESTAURAR la base $what."
  echo "Se detienen postgres, el sidecar de backups y ($APP_SERVICES); los datos actuales se reemplazan."
  read -r -p "Escribe RESTAURAR para continuar: " answer
  [ "$answer" = "RESTAURAR" ] || { log "cancelado"; exit 1; }
fi

# Servicios en marcha antes de empezar: se vuelven a levantar al final (solo esos).
running=$($COMPOSE ps --services --status running 2>/dev/null || true)
to_restart=()
for svc in $APP_SERVICES; do
  if grep -qx "$svc" <<<"$running"; then to_restart+=("$svc"); fi
done

stop=()
for svc in "${to_restart[@]}" pgbackrest postgres; do stop+=("$svc"); done
log "deteniendo: ${stop[*]}"
$COMPOSE stop "${stop[@]}"

log "restaurando ($what)"
pgbr restore "${restore_opts[@]}"

log "arrancando postgres (aplica los WAL con archive-get hasta el objetivo)"
$COMPOSE up -d --no-deps postgres
for i in $(seq 1 180); do
  if [ "$(psql_q 'select pg_is_in_recovery()' 2>/dev/null || true)" = "f" ]; then break; fi
  [ "$i" = 180 ] && { log "ERROR: postgres no terminó la recuperación en 6 min; revisa: $COMPOSE logs postgres"; exit 1; }
  sleep 2
done
log "recuperación terminada: $(psql_q "select 'línea de tiempo ' || timeline_id from pg_control_checkpoint()")"

log "arrancando el sidecar de backups${to_restart:+ y ${to_restart[*]}}"
$COMPOSE up -d --no-deps pgbackrest "${to_restart[@]}"

if [ "$backup_after" = 1 ]; then
  log "backup full posterior a la restauración"
  $COMPOSE exec -T pgbackrest pgbackrest --stanza="$STANZA" backup --type=full
  $COMPOSE exec -T pgbackrest sh -c "date -u '+%Y-%m-%dT%H:%M:%SZ' > /var/lib/pgbackrest/last-ok"
elif [ -n "$target$set" ]; then
  log "Recomendado: un full nuevo tras el PITR ->  $COMPOSE exec pgbackrest pgbackrest --stanza=$STANZA backup --type=full"
fi
log "listo"
