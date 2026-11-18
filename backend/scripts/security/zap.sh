#!/usr/bin/env bash
# DAST: OWASP ZAP (zap-api-scan, escaneo pasivo + activo) contra la API corriendo en Docker.
#   bash scripts/security/zap.sh            (desde backend/)
#
# Todo es desechable: una red Docker propia, PostgreSQL sin volumen (tmpfs), Valkey y la API
# construida con el Dockerfile real (NODE_ENV=production, claves aleatorias). No toca la base
# `moda` ni los volúmenes del docker-compose. Al terminar se borran los contenedores y la red.
#
# Pasos: build de la imagen -> migraciones -> seed de desarrollo -> token de staff con todos los
# permisos -> OpenAPI generado de los DTOs -> ZAP ataca cada operación con el token y X-Tenant-Id.
# El rate limiting se apaga solo para el escaneo (si no, ZAP recibiría 429 y no probaría nada).
# Informes: backend/security-reports/zap-report.{html,json,md}
set -euo pipefail

cd "$(dirname "$0")/../.."   # backend/
OUT="$(pwd)/security-reports"
mkdir -p "$OUT"
RUN="moda-zap-$$"
NET="$RUN-net"
PG="$RUN-pg"
VK="$RUN-valkey"
API="$RUN-api"
ZAP_IMAGE="${ZAP_IMAGE:-zaproxy/zap-stable}"
export MSYS_NO_PATHCONV=1

cleanup() {
  docker rm -f "$API" "$PG" "$VK" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

rand() { node -e "console.log(require('crypto').randomBytes($1).toString('base64'))"; }
JWT_SECRET="$(rand 48)"
ENV_ARGS=(
  -e NODE_ENV=production
  -e "DATABASE_URL=postgres://app:zap@$PG:5432/moda"
  -e "VALKEY_URL=redis://$VK:6379"
  -e "JWT_SECRET=$JWT_SECRET"
  -e "MFA_ENCRYPTION_KEY=$(rand 32)"
  -e "DATA_ENCRYPTION_KEY=$(rand 32)"
  -e "PAYSIM_SECRET=$(rand 24)"
  -e "COURIERSIM_API_KEY=$(rand 24)"
  -e COURIERSIM_URL=http://127.0.0.1:9 -e PAYSIM_API_URL=http://127.0.0.1:9 -e SRI_URL=http://127.0.0.1:9
  -e OSRM_URL= -e NOMINATIM_URL=
  -e VOUCHER_STORAGE=memory -e RETURN_PHOTO_STORAGE=memory -e REVIEW_PHOTO_STORAGE=memory
  -e DOCUMENT_STORAGE=memory -e REPORT_EXPORT_STORAGE=memory
  -e MAIL_TRANSPORT=memory -e NOTIFICATION_TRANSPORT=memory
  -e SRI_CERT_PATH=test/fixtures/sri/firma.crt.pem -e SRI_KEY_PATH=test/fixtures/sri/firma.key.pem
  -e RATE_LIMIT_ENABLED=false
)

echo "== Imágenes: API (runtime) y herramientas (seed, token y OpenAPI) =="
docker build -q -t moda-api:zap . >/dev/null
# Herramientas (seed, token y OpenAPI) con dependencias de desarrollo: la etapa de build de la
# imagen hace npm prune --omit=dev, así que no trae ts-node.
docker build -q -t moda-api-tools:zap -f - . >/dev/null <<'DOCKERFILE'
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY apps ./apps
COPY libs ./libs
COPY scripts ./scripts
COPY migrations ./migrations
DOCKERFILE

echo "== Red, PostgreSQL (tmpfs) y Valkey desechables =="
docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_DB=moda -e POSTGRES_USER=app -e POSTGRES_PASSWORD=zap postgis/postgis:16-3.4 >/dev/null
docker run -d --name "$VK" --network "$NET" valkey/valkey:8-alpine >/dev/null
for _ in $(seq 1 60); do docker exec "$PG" pg_isready -U app -d moda -h 127.0.0.1 >/dev/null 2>&1 && break; sleep 1; done
sleep 2

# La imagen no copia test/ (certificado de prueba del SRI): se monta de solo lectura.
BUILD_RUN=(docker run --rm --network "$NET" "${ENV_ARGS[@]}" -v "$(pwd -W 2>/dev/null || pwd)/test/fixtures:/app/test/fixtures:ro" moda-api-tools:zap)

echo "== Migraciones y seed =="
# Las migraciones van en la imagen de runtime (la etapa de build no las copia), igual que en producción.
docker run --rm --network "$NET" "${ENV_ARGS[@]}" moda-api:zap node node_modules/node-pg-migrate/bin/node-pg-migrate.js -m migrations -j js up >/dev/null
SEED="$("${BUILD_RUN[@]}" npm run -s seed:dev)"   # stderr queda en la consola si falla
read -r TENANT USER_ID ORDER_ID < <(node -e '
  const out = require("fs").readFileSync(0, "utf8");
  const s = JSON.parse(out.slice(out.indexOf("{\n")));
  console.log(s.tenantId, s.userId, s.orderIds[0] ?? s.variantIds[0]);
' <<<"$SEED")
echo "tenant $TENANT, staff $USER_ID"
# token:dev se niega con NODE_ENV=production (a propósito): aquí se emite con development.
TOKEN="$(docker run --rm -e NODE_ENV=development -e "JWT_SECRET=$JWT_SECRET" moda-api-tools:zap npm run -s token:dev -- "$TENANT" "$USER_ID")"

echo "== API en Docker =="
docker run -d --name "$API" --network "$NET" "${ENV_ARGS[@]}" -v "$(pwd -W 2>/dev/null || pwd)/test/fixtures:/app/test/fixtures:ro" moda-api:zap >/dev/null
for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$API")" = healthy ] && break
  sleep 2
done
docker inspect -f 'API: {{.State.Health.Status}}' "$API"

echo "== OpenAPI desde los DTOs =="
"${BUILD_RUN[@]}" sh -c "node -r ts-node/register/transpile-only scripts/security/openapi.ts /tmp/openapi.json http://$API:3000 $ORDER_ID >/dev/null && cat /tmp/openapi.json" >"$OUT/openapi.json"

echo "== OWASP ZAP (puede tardar 20-60 min) =="
# zap-api-scan separa -z con shlex: los valores con espacios van entre comillas.
rule() { # índice, header, valor
  local p="replacer.full_list($1)"
  echo "-config $p.description=h$1 -config $p.enabled=true -config $p.matchtype=REQ_HEADER -config $p.matchstr=$2 -config $p.regex=false -config \"$p.replacement=$3\""
}
set +e
docker run --rm --network "$NET" -v "$(pwd -W 2>/dev/null || pwd)/security-reports:/zap/wrk:rw" "$ZAP_IMAGE" \
  zap-api-scan.py -t /zap/wrk/openapi.json -f openapi -r zap-report.html -J zap-report.json -w zap-report.md -I \
  -z "$(rule 0 Authorization "Bearer $TOKEN") $(rule 1 X-Tenant-Id "$TENANT")"
ZAP_EXIT=$?
set -e
echo "== Logs de la API (errores 5xx que provocó el escaneo) =="
docker logs "$API" 2>&1 | grep -E '"status":5|ERROR' | tail -40 || true
echo "ZAP terminó con código $ZAP_EXIT. Informes en backend/security-reports/zap-report.{html,json,md}"
