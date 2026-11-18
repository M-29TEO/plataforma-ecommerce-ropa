import { api } from './api/client';

/** La clave pública VAPID viene en base64url; PushManager.subscribe la quiere en bytes. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/**
 * Suscribe este navegador a Web Push y lo registra en el backend (requiere sesión de cliente).
 * El backend rechaza campos extra: se manda solo { endpoint, keys } (sin expirationTime).
 */
export async function subscribePush(): Promise<'subscribed' | 'denied' | 'unavailable'> {
  if (!pushSupported()) return 'unavailable';
  const { publicKey } = await api<{ publicKey: string | null }>('/notifications/push/public-key');
  if (!publicKey) return 'unavailable';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }));
  const json = subscription.toJSON();
  await api('/me/push-subscriptions', {
    method: 'POST',
    body: { endpoint: json.endpoint, keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth } },
  });
  return 'subscribed';
}

export async function unsubscribePush(): Promise<void> {
  if (!pushSupported()) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  await api('/me/push-subscriptions', { method: 'DELETE', body: { endpoint: subscription.endpoint } }).catch(() => undefined);
  await subscription.unsubscribe();
}

export async function currentPushState(): Promise<'subscribed' | 'not_subscribed' | 'denied' | 'unavailable'> {
  if (!pushSupported()) return 'unavailable';
  if (Notification.permission === 'denied') return 'denied';
  const registration = await navigator.serviceWorker.getRegistration();
  const sub = await registration?.pushManager.getSubscription();
  return sub ? 'subscribed' : 'not_subscribed';
}
