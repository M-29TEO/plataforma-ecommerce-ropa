import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';

/**
 * Avisos locales (sin Firebase: la app no usa push de Google). La oferta llega por ntfy (WebSocket
 * mientras dura el turno) o por la respuesta del GPS; si la app no está en pantalla, se muestra
 * una notificación que abre /ofertas.
 */
export const OFFERS_CHANNEL = 'ofertas';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

export async function setupNotifications(): Promise<boolean> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(OFFERS_CHANNEL, {
      name: 'Ofertas de pedidos',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 400, 200, 400],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  }
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  return (await Notifications.requestPermissionsAsync()).granted;
}

let lastNotifiedAt = 0;

/** Una notificación por ráfaga (ntfy y el GPS pueden avisar de la misma oferta). */
export async function notifyNewOffer(title = 'Nueva oferta de entrega', body = 'Ábrela para aceptarla antes de que venza'): Promise<void> {
  if (AppState.currentState === 'active') return;
  const now = Date.now();
  if (now - lastNotifiedAt < 20_000) return;
  lastNotifiedAt = now;
  await Notifications.scheduleNotificationAsync({
    content: { title, body, data: { url: 'modarider://ofertas' }, priority: Notifications.AndroidNotificationPriority.MAX },
    trigger: Platform.OS === 'android' ? { channelId: OFFERS_CHANNEL } : null,
  }).catch(() => undefined);
}
