# App del motorizado (React Native + Expo)

App Android para los motorizados: turno con GPS en segundo plano, ofertas de pedidos por **ntfy**,
mapa con **MapLibre**, estados del envío, prueba de entrega (foto, firma y código OTP), cobro contra
entrega y ganancias. Consume la API del backend (`/v1/rider/...`) por Caddy, igual que la tienda.

Expo SDK 57 (React Native 0.86) con **Expo Router**. Sin servicios pagos: nada de Google Maps,
Firebase ni EAS; el APK se compila localmente con `expo prebuild` dentro de un contenedor.

## Qué incluye

| Pantalla | Qué hace |
|---|---|
| **Login** (`/login`) | Correo y contraseña del motorizado (`POST /auth/login`, con segundo paso si la cuenta tiene 2FA). Rechaza cuentas que no son de motorizado. |
| **Turno** (pestaña inicial) | Iniciar/terminar turno (`/rider/shift/start` · `/end`, con resumen de entregas y ganancia), pausa/disponible (`/rider/presence`), estado del GPS y de la conexión a ntfy, **ofertas con cuenta regresiva** para aceptar o rechazar (con motivo), envíos en curso y efectivo por liquidar frente al tope. |
| **Mapa** | MapLibre con la posición del motorizado y un pin por envío (B = bodega antes del retiro, C = cliente después). |
| **Ganancias** | Hoy / esta semana / semana pasada (`/rider/earnings`): comisiones, bono estimado, cobros por método, efectivo por entregar, detalle por día y por entrega. |
| **Envío** (`/envio/<id>`) | Mapa, **botón de navegación** (abre la app de mapas del teléfono con `geo:`; sin ninguna, la ruta OSRM de openstreetmap.org), llamar al cliente y botones del siguiente estado: *Retiré el paquete* → *Salir hacia el cliente* → *Estoy llegando* → *Entregar* / *No pude entregar* (motivo) → *Reintentar*. |
| **Prueba de entrega** (`/entregar/<id>`) | Foto con la cámara (redimensionada a 1280 px), nombre de quien recibe, **código OTP** de 4 dígitos que el cliente ve en su seguimiento, **cobro contra entrega** (efectivo con cálculo de vuelto, tarjeta POS o DeUna QR) y **firma en pantalla** (SVG → PNG). Se envía en un solo `multipart/form-data`. |
| **Ofertas** (`/ofertas`, `modarider://ofertas`) | Se abre al tocar la notificación de una oferta. |

### Cómo funciona

- **GPS en segundo plano**: `expo-location` con servicio en primer plano de Android (notificación fija
  "Turno activo") y una tarea de `expo-task-manager` (`src/lib/location-task.ts`). Se envía una posición
  cada **10 s** (`GPS_INTERVAL_MS`); sin señal se encolan (hasta 300, menos de 55 min) y se reenvían en
  orden. Si Android cierra la app, el servicio la relanza solo para la tarea (el token está en el
  Keystore con `expo-secure-store`). Al reabrir con un turno activo se reanuda.
- **Ofertas por ntfy**: con el turno activo la app se suscribe por WebSocket a su tópico privado
  (`GET /rider/me` → `ntfy.url` + `ntfy.topic`), con reconexión creciente. El mensaje no trae datos del
  cliente (los tópicos de ntfy son públicos para quien sepa el nombre): solo avisa, y la app pide el
  detalle con sesión a `GET /rider/offers`. Si ntfy está caído, la respuesta de cada posición GPS trae
  `openOffers` y la lista se refresca cada 20 s. Con la app minimizada se muestra una notificación local
  (canal "Ofertas de pedidos", sin Firebase).
- **Sesión**: access token de 15 min en el header; el refresh token es la cookie httpOnly de siempre,
  guardada por el almacén de cookies nativo (OkHttp). Nunca pasa por JavaScript.
- **Horas**: America/Guayaquil (UTC−5 fijo) calculado a mano: el `Intl` de Hermes en Android no
  siempre respeta `timeZone`.
- **Mapa**: `EXPO_PUBLIC_MAP_TILES=osm` usa teselas raster de openstreetmap.org (solo desarrollo, por su
  política de uso); `pmtiles` usa el mismo `ecuador.pmtiles` que sirve Caddy en `/tiles` con el estilo
  de Protomaps (MapLibre Native entiende `pmtiles://`).

## Configuración

Copia `.env.example` a `.env.local`. Las variables `EXPO_PUBLIC_*` se fijan **al construir**:

| Variable | Ejemplo | Nota |
|---|---|---|
| `EXPO_PUBLIC_API_URL` | `http://192.168.1.20/api` | Caddy del `docker compose --profile front`. Emulador: `http://10.0.2.2/api`. |
| `EXPO_PUBLIC_MAP_TILES` | `osm` \| `pmtiles` | |
| `EXPO_PUBLIC_PMTILES_URL` | `http://192.168.1.20/tiles/ecuador.pmtiles` | Solo con `pmtiles`. |
| `RIDER_ALLOW_HTTP` | `1` | Permite `http://` aunque la API vaya por https (p. ej. ntfy de desarrollo). Con la API en `http://` ya se permite. |

En el backend: `NTFY_PUBLIC_URL` debe ser la URL de ntfy **vista desde el teléfono** (p. ej.
`http://192.168.1.20:8090`). Para probar por `http://` en la red local, `SECURE_COOKIES=false` en la API
(si no, Android no reenvía la cookie de refresh por http y la sesión dura 15 min).

## Build local de Android (sin Android Studio)

```bash
cd rider-app
npm install
npm run typecheck && npm test            # TypeScript y Jest (jest-expo)
npm run build:apk                         # → dist/moda-rider-1.0.0-release.apk
```

`scripts/build-android.sh` crea un contenedor desechable con la imagen
`reactnativecommunity/react-native-android` (JDK 17 + SDK + NDK), le copia el código, corre
`npm ci`, **`npx expo prebuild --platform android --clean`** y `./gradlew assembleRelease`, y copia el
APK a `dist/`. No instala Java ni el SDK en el PC. La primera vez descarga Gradle y las dependencias
(~15–25 min); `GRADLE_CACHE_VOLUME=moda-rider-gradle npm run build:apk` las cachea en un volumen de
Docker. `VARIANT=debug` genera un APK de desarrollo (usa Metro: `npx expo start --dev-client`).

Instalar en un teléfono con depuración USB: `adb install -r dist/moda-rider-1.0.0-release.apk`, o
copiar el APK al teléfono y abrirlo. El APK release va firmado con la clave de depuración de la
plantilla de Expo: para publicarlo, configura una clave propia (`android.signingConfigs`) con un
config plugin.

`android/` es generado (Continuous Native Generation): **no se edita a mano** ni se versiona; todo lo
nativo se configura en `app.config.ts` (permisos, servicio en primer plano, cámara, notificaciones,
`usesCleartextTraffic`).

## Probar de punta a punta

1. Backend con el perfil `front` (`docker compose --profile front up`) y el seed (`npm run seed:dev`):
   el motorizado de demo es `moto@demo.test` / `Demo-2026-segura`.
2. Instala el APK, inicia sesión e **inicia turno** (acepta la ubicación "todo el tiempo").
3. Haz un pedido con envío por motorizado en la tienda y termina el picking en el backoffice: el envío
   pasa a *listo para retirar* y la API ofrece el pedido al mejor motorizado (o usa **Despacho →
   Ofrecer al mejor disponible**). Llega la notificación; acepta.
4. *Retiré el paquete* → *Salir hacia el cliente*. El cliente ve el **código de entrega** en
   `/seguimiento/<token>`.
5. Cerca del destino (≤ 300 m; en el emulador fija la ubicación desde *Extended controls → Location*),
   *Entregar*: foto, código, cobro y firma. En el backoffice, **Liquidaciones → detalle → Prueba** muestra
   la foto, la firma y el OTP verificado.

## Estructura

```
src/app/                 rutas de Expo Router
  login.tsx
  (app)/_layout.tsx      exige sesión; abre /ofertas desde la notificación
  (app)/(tabs)/          Turno (index), Mapa, Ganancias
  (app)/envio/[id].tsx   detalle, navegación y estados
  (app)/entregar/[id].tsx prueba de entrega
  (app)/ofertas.tsx
src/components/          UI, mapa (MapLibre), firma, tarjeta de oferta
src/lib/                 API, sesión, GPS (tarea + cola), ntfy, formatos y reglas puras (con tests)
scripts/build-android.sh build del APK en Docker
```
