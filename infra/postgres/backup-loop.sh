#!/usr/bin/env bash
# Sidecar de backups (servicio `pgbackrest` del compose). Corre como usuario postgres.
#
#  1. Espera a PostgreSQL, crea la stanza `moda` si no existe (idempotente) y verifica el archivado.
#  2. Si un repositorio no tiene ningún backup, hace un full en el acto: desde ahí ya hay PITR.
#  3. Cada día a las BACKUP_HOUR (hora de Ecuador): full el día BACKUP_FULL_DOW (1=lunes … 7=domingo)
#     y diferencial el resto. pgBackRest aplica la retención (expire) al terminar cada backup.
#
# Repositorios: repo1 (volumen local) siempre; repo2 (fuera del servidor, deploy/compose.offsite.yml)
# si PGBACKREST_REPO2_TYPE está definido. pgBackRest respalda en UN repo por comando, así que se hace
# un backup por repositorio (los WAL sí van a los dos solos, con archive-push).
#
# Cada ronda buena actualiza /var/lib/pgbackrest/last-ok (lo mira el healthcheck). Si un backup falla
# y hay NTFY_URL + NTFY_OPS_TOPIC, avisa al mismo tópico de operación que Grafana y Uptime Kuma.
set -uo pipefail

STANZA=moda
BACKUP_HOUR="${BACKUP_HOUR:-2}"
BACKUP_FULL_DOW="${BACKUP_FULL_DOW:-7}"
LAST_OK=/var/lib/pgbackrest/last-ok
REPOS="1"
[ -n "${PGBACKREST_REPO2_TYPE:-}" ] && REPOS="1 2"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S %Z') [backup] $*"; }

# POST a ntfy por la red interna (NTFY_URL=http://host[:puerto]) con /dev/tcp: la imagen no trae curl.
notify() {
  [ -n "${NTFY_URL:-}" ] && [ -n "${NTFY_OPS_TOPIC:-}" ] || return 0
  local hostport="${NTFY_URL#http://}"; hostport="${hostport%%/*}"
  local host="${hostport%%:*}" port="${hostport##*:}"
  [ "$port" = "$host" ] && port=80
  local body="$1" status=""
  if exec 3<>"/dev/tcp/$host/$port"; then
    printf 'POST /%s HTTP/1.1\r\nHost: %s\r\nTitle: Backup de PostgreSQL\r\nPriority: high\r\nTags: floppy_disk,warning\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s' \
      "$NTFY_OPS_TOPIC" "$host" "$(printf '%s' "$body" | wc -c)" "$body" >&3
    read -r -t 10 status <&3 || true
    exec 3>&-
  fi 2>/dev/null
  case "$status" in *" 200 "*) ;; *) log "no se pudo avisar a ntfy (${status:-sin respuesta})" ;; esac
}

run_backup() {
  local type="$1" repo="$2"
  log "iniciando backup $type en repo$repo"
  if pgbackrest --stanza="$STANZA" --repo="$repo" backup --type="$type"; then
    log "backup $type en repo$repo terminado"
  else
    log "ERROR: falló el backup $type en repo$repo"
    notify "Falló el backup $type de PostgreSQL en repo$repo ($(hostname)). Revisa: docker compose logs pgbackrest"
    return 1
  fi
}

# Una ronda: el mismo tipo de backup en cada repositorio; last-ok solo si todos salieron bien.
run_round() {
  local ok=1 repo
  for repo in $REPOS; do run_backup "$1" "$repo" || ok=0; done
  [ "$ok" = 1 ] && date -u '+%Y-%m-%dT%H:%M:%SZ' > "$LAST_OK"
}

log "esperando a PostgreSQL en /var/run/postgresql"
until pg_isready -q -h /var/run/postgresql -U app -d moda; do sleep 2; done

# stanza-create es idempotente: si la stanza ya existe y coincide con el cluster, no hace nada.
until pgbackrest --stanza="$STANZA" stanza-create; do
  log "stanza-create falló; reintento en 30 s"
  notify "pgBackRest no pudo crear la stanza (¿cluster distinto al del repositorio?)"
  sleep 30
done
pgbackrest --stanza="$STANZA" check || notify "pgbackrest check falló: el archivado de WAL no funciona"

# Repositorio vacío (instalación nueva, o repo1 recreado tras restaurar desde repo2): full inicial.
initial_ok=1
for repo in $REPOS; do
  if ! pgbackrest --stanza="$STANZA" --repo="$repo" info --output=json | grep -q '"label"'; then
    log "repo$repo sin backups: full inicial"
    run_backup full "$repo" || initial_ok=0
  fi
done
[ "$initial_ok" = 1 ] && [ ! -f "$LAST_OK" ] && date -u '+%Y-%m-%dT%H:%M:%SZ' > "$LAST_OK"

while true; do
  now=$(date +%s)
  next=$(date -d "today ${BACKUP_HOUR}:00" +%s)
  [ "$next" -le "$now" ] && next=$(date -d "tomorrow ${BACKUP_HOUR}:00" +%s)
  log "próximo backup: $(date -d "@$next" '+%Y-%m-%d %H:%M %Z')"
  sleep $((next - now))
  if [ "$(date +%u)" = "$BACKUP_FULL_DOW" ]; then run_round full; else run_round diff; fi
  sleep 60   # no repetir dentro del mismo minuto
done
