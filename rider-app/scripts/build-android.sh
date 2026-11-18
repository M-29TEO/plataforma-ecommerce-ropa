#!/usr/bin/env bash
# Build local del APK de Android SIN instalar Java ni el SDK de Android en el PC: todo corre en un
# contenedor desechable (imagen reactnativecommunity/react-native-android: JDK 17 + SDK + NDK).
#
#   npm run build:apk                       # APK release en dist/moda-rider-<versión>.apk
#   VARIANT=debug npm run build:apk         # APK debug (con el menú de desarrollo; usa Metro)
#   GRADLE_CACHE_VOLUME=moda-rider-gradle npm run build:apk   # opcional: cachea Gradle entre builds
#
# Las URLs de la API y del mapa se fijan aquí (EXPO_PUBLIC_*, ver .env.example): se leen del
# entorno o de .env.local. El código se copia al contenedor con tar (un bind mount de la carpeta de
# OneDrive es lentísimo) y solo vuelve el APK.
set -euo pipefail

cd "$(dirname "$0")/.."
IMAGE="${ANDROID_BUILD_IMAGE:-reactnativecommunity/react-native-android:latest}"
VARIANT="${VARIANT:-release}"
NAME="moda-rider-build-$$"
VERSION="$(node -p "require('./package.json').version")"
mkdir -p dist

if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.local
  set +a
fi

CACHE_ARGS=()
if [ -n "${GRADLE_CACHE_VOLUME:-}" ]; then CACHE_ARGS=(-v "${GRADLE_CACHE_VOLUME}:/root/.gradle"); fi

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Git Bash convierte rutas tipo /app en rutas de Windows: se desactiva para los argumentos de docker.
export MSYS_NO_PATHCONV=1

docker create --name "$NAME" -w /app "${CACHE_ARGS[@]}" \
  -e CI=1 -e NODE_ENV=production -e GRADLE_OPTS="-Xmx4g -Dorg.gradle.daemon=false" \
  -e EXPO_PUBLIC_API_URL="${EXPO_PUBLIC_API_URL:-http://10.0.2.2/api}" \
  -e EXPO_PUBLIC_MAP_TILES="${EXPO_PUBLIC_MAP_TILES:-osm}" \
  -e EXPO_PUBLIC_PMTILES_URL="${EXPO_PUBLIC_PMTILES_URL:-}" \
  -e RIDER_ALLOW_HTTP="${RIDER_ALLOW_HTTP:-}" \
  "$IMAGE" bash -lc "
    set -euo pipefail
    npm ci --no-audit --no-fund
    npx expo prebuild --platform android --clean --no-install
    cd android
    ./gradlew --no-daemon --console=plain assemble${VARIANT^} -PreactNativeArchitectures=arm64-v8a,armeabi-v7a,x86_64
  " >/dev/null

echo "Copiando el código al contenedor…"
tar --exclude=./node_modules --exclude=./android --exclude=./ios --exclude=./.expo --exclude=./dist --transform 's,^\.,app,' -cf - . | docker cp - "$NAME:/"

echo "Compilando ($VARIANT)… la primera vez tarda (descarga Gradle y dependencias)."
docker start -a "$NAME"

OUT="dist/moda-rider-${VERSION}-${VARIANT}.apk"
docker cp "$NAME:/app/android/app/build/outputs/apk/${VARIANT}/app-${VARIANT}.apk" "$OUT"
echo "APK listo: $OUT"
