#!/usr/bin/env bash
# Certificado AUTOFIRMADO para firmar comprobantes electrónicos (XAdES-BES) en desarrollo.
#
# El SRI real exige una firma .p12 emitida por una entidad acreditada (Banco Central, Security
# Data...), que tiene costo. Para el proyecto se genera un par RSA 2048 y un certificado X.509
# autofirmado con los datos del emisor; el simulador del SRI lo acepta. NO sirve ante el SRI real.
#
# Uso (desde backend/, en Git Bash, Linux o macOS):
#   bash scripts/generate-sri-cert.sh                       # → secrets/sri/
#   bash scripts/generate-sri-cert.sh ruta/de/salida 1790000000001 "MODA DEMO S.A."
#
# Genera:
#   firma.key.pem   clave privada RSA (PKCS#8, sin contraseña)  → SRI_KEY_PATH
#   firma.crt.pem   certificado X.509 (2 años)                   → SRI_CERT_PATH
#   firma.p12       el mismo par en PKCS#12, como lo entrega una entidad certificadora
#                   (contraseña: $SRI_P12_PASSWORD o "cambia_esto")
# Sin OpenSSL local:  docker run --rm -v "$PWD:/w" -w /w alpine/openssl ... (o ejecuta este script
# dentro de un contenedor con bash y openssl).
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash no debe convertir "/C=EC/..." en una ruta de Windows

OUT="${1:-secrets/sri}"
RUC="${2:-${SRI_RUC:-1790000000001}}"
NAME="${3:-${SRI_RAZON_SOCIAL:-MODA DEMO S.A.}}"
P12_PASSWORD="${SRI_P12_PASSWORD:-cambia_esto}"

if ! [[ "$RUC" =~ ^[0-9]{13}$ ]]; then
  echo "El RUC debe tener 13 dígitos: $RUC" >&2
  exit 1
fi
command -v openssl >/dev/null || { echo "Falta openssl en el PATH" >&2; exit 1; }

mkdir -p "$OUT"
KEY="$OUT/firma.key.pem"
CRT="$OUT/firma.crt.pem"
P12="$OUT/firma.p12"

if [[ -f "$KEY" && "${FORCE:-}" != "1" ]]; then
  echo "Ya existe $KEY (usa FORCE=1 para regenerarlo)." >&2
  exit 1
fi

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$KEY" 2>/dev/null
openssl req -new -x509 -key "$KEY" -out "$CRT" -days 730 -sha256 \
  -set_serial "0x$(openssl rand -hex 8)" \
  -subj "/C=EC/O=${NAME}/OU=FIRMA ELECTRONICA DE PRUEBAS - AUTOFIRMADA/serialNumber=${RUC}/CN=${NAME}" \
  -addext "keyUsage=critical,digitalSignature,nonRepudiation" \
  -addext "basicConstraints=critical,CA:FALSE"
openssl pkcs12 -export -inkey "$KEY" -in "$CRT" -name "firma-sri" -out "$P12" -passout "pass:${P12_PASSWORD}"
chmod 600 "$KEY" "$P12" 2>/dev/null || true

echo "Certificado de firma generado en $OUT:"
openssl x509 -in "$CRT" -noout -subject -serial -enddate
echo
echo "Configura en backend/.env (o en el worker):"
echo "  SRI_CERT_PATH=$CRT"
echo "  SRI_KEY_PATH=$KEY"
