import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Configuración de Expo (CNG: `expo prebuild` genera android/ desde aquí; nunca se edita a mano).
 *
 * Las URLs se fijan al construir (variables EXPO_PUBLIC_*, ver .env.example). Si la API va por
 * http:// (desarrollo en la red local), se permite tráfico sin TLS; con https:// queda bloqueado
 * salvo RIDER_ALLOW_HTTP=1 (p. ej. ntfy de desarrollo en http://<pc>:8090 con la API en https).
 */
const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2/api';
const allowHttp = apiUrl.startsWith('http://') || process.env.RIDER_ALLOW_HTTP === '1';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Moda Motorizado',
  slug: 'moda-rider',
  scheme: 'modarider',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'light',
  android: {
    package: 'ec.moda.rider',
    versionCode: 1,
    adaptiveIcon: {
      backgroundColor: '#111827',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    // Lo mínimo para el turno: GPS en segundo plano con servicio en primer plano, cámara y avisos.
    permissions: [
      'ACCESS_COARSE_LOCATION',
      'ACCESS_FINE_LOCATION',
      'ACCESS_BACKGROUND_LOCATION',
      'FOREGROUND_SERVICE',
      'FOREGROUND_SERVICE_LOCATION',
      'CAMERA',
      'POST_NOTIFICATIONS',
      'VIBRATE',
    ],
    blockedPermissions: ['android.permission.RECORD_AUDIO', 'android.permission.READ_EXTERNAL_STORAGE', 'android.permission.WRITE_EXTERNAL_STORAGE'],
    predictiveBackGestureEnabled: false,
  },
  ios: { bundleIdentifier: 'ec.moda.rider', supportsTablet: false },
  plugins: [
    'expo-router',
    'expo-secure-store',
    '@maplibre/maplibre-react-native',
    [
      'expo-location',
      {
        locationAlwaysAndWhenInUsePermission: 'Durante tu turno enviamos tu ubicación a la central para asignarte pedidos y para que el cliente vea su entrega.',
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true,
      },
    ],
    ['expo-image-picker', { cameraPermission: 'La cámara se usa para la foto de prueba de entrega.', microphonePermission: false }],
    ['expo-notifications', { color: '#111827' }],
    ['expo-build-properties', { android: { usesCleartextTraffic: allowHttp } }],
  ],
  experiments: { typedRoutes: false },
});
