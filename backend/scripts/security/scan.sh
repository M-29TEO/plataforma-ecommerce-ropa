#!/usr/bin/env bash
# Análisis estático de seguridad en contenedores desechables (nada se instala en la máquina):
#   bash scripts/security/scan.sh semgrep   -> SAST: reglas OWASP/Node/TypeScript/secretos + .semgrep.yml
#   bash scripts/security/scan.sh trivy     -> SCA (dependencias con CVE), misconfig (Dockerfile, compose) y secretos
#   bash scripts/security/scan.sh all
# Los informes quedan en backend/security-reports/ (ignorado por git). Sale con código != 0 si hay
# hallazgos bloqueantes (Semgrep ERROR; Trivy HIGH/CRITICAL no ignorados en .trivyignore).
#
# El código se envía al contenedor como un tar por stdin con los archivos que git versionaría
# (git ls-files): sin node_modules ni dist, y mucho más rápido que montar una carpeta de OneDrive.
set -euo pipefail

cd "$(dirname "$0")/../../.."   # raíz del repositorio
ROOT="$(pwd)"
OUT="$ROOT/backend/security-reports"
mkdir -p "$OUT"
SEMGREP_IMAGE="${SEMGREP_IMAGE:-semgrep/semgrep:latest}"
TRIVY_IMAGE="${TRIVY_IMAGE:-aquasec/trivy:latest}"

source_tar() {
  git ls-files -z --cached --others --exclude-standard | tar --null -T - -cf -
}

run_semgrep() {
  echo "== Semgrep (SAST) =="
  source_tar | MSYS_NO_PATHCONV=1 docker run --rm -i --entrypoint sh "$SEMGREP_IMAGE" -c '
    mkdir -p /src && tar -xf - -C /src && cd /src &&
    semgrep scan --metrics=off --quiet \
      --config p/owasp-top-ten --config p/nodejs --config p/typescript --config p/secrets \
      --config .semgrep.yml \
      --exclude "backend/test" --exclude "*.spec.ts" --exclude "simulators/*/fixtures" \
      --json --output /tmp/semgrep.json backend simulators >/dev/null 2>&1 || true
    cat /tmp/semgrep.json' > "$OUT/semgrep.json"
  node -e '
    const r = require(process.argv[1]);
    const rows = r.results.map((x) => `${x.extra.severity.padEnd(8)} ${x.check_id.split(".").pop()}  ${x.path}:${x.start.line}`);
    console.log(rows.length ? rows.join("\n") : "Sin hallazgos");
    const blocking = r.results.filter((x) => x.extra.severity === "ERROR").length;
    console.log(`Semgrep: ${r.results.length} hallazgos, ${blocking} bloqueantes (ERROR). Informe: backend/security-reports/semgrep.json`);
    process.exit(blocking ? 1 : 0);
  ' "$OUT/semgrep.json"
}

run_trivy() {
  echo "== Trivy (dependencias, misconfig y secretos) =="
  source_tar | MSYS_NO_PATHCONV=1 docker run --rm -i --entrypoint sh "$TRIVY_IMAGE" -c '
    mkdir -p /src && tar -xf - -C /src && cd /src &&
    trivy fs --config trivy.yaml --exit-code 0 --format json --output /tmp/trivy.json . >/dev/null 2>&1;
    trivy fs --config trivy.yaml --skip-db-update --severity HIGH,CRITICAL --exit-code 1 --quiet . >/dev/null 2>&1;
    code=$?; cat /tmp/trivy.json; exit $code' > "$OUT/trivy.json" && status=0 || status=$?
  node -e '
    const r = require(process.argv[1]);
    for (const res of r.Results ?? []) {
      for (const v of res.Vulnerabilities ?? []) console.log(`${v.Severity.padEnd(8)} ${v.VulnerabilityID} ${v.PkgName}@${v.InstalledVersion} -> ${v.FixedVersion || "sin fix"}  (${res.Target})`);
      for (const m of res.Misconfigurations ?? []) console.log(`${m.Severity.padEnd(8)} ${m.ID} ${m.Title}  (${res.Target})`);
      for (const s of res.Secrets ?? []) console.log(`${s.Severity.padEnd(8)} secreto ${s.RuleID}  (${res.Target}:${s.StartLine})`);
    }
    console.log("Informe: backend/security-reports/trivy.json");
  ' "$OUT/trivy.json"
  if [ "$status" -ne 0 ]; then echo "Trivy: hay hallazgos HIGH/CRITICAL (ver arriba)"; fi
  return "$status"
}

case "${1:-all}" in
  semgrep) run_semgrep ;;
  trivy) run_trivy ;;
  all) rc=0; run_semgrep || rc=1; run_trivy || rc=1; exit $rc ;;
  *) echo "Uso: scan.sh semgrep|trivy|all" >&2; exit 2 ;;
esac
