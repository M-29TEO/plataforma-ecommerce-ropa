import * as Notifications from 'expo-notifications';
import { Redirect, router, Stack } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { colors } from '@/components/ui';
import { useSession } from '@/lib/session';

/** Tocar la notificación de una oferta abre la lista de ofertas. */
function useOfferNotificationTaps() {
  useEffect(() => {
    const open = (n: Notifications.Notification | undefined) => {
      const url = n?.request.content.data?.url;
      if (typeof url === 'string' && url.startsWith('modarider://ofertas')) router.push('/ofertas');
    };
    const last = Notifications.getLastNotificationResponse();
    if (last) {
      open(last.notification);
      Notifications.clearLastNotificationResponse();
    }
    const sub = Notifications.addNotificationResponseReceivedListener((r) => open(r.notification));
    return () => sub.remove();
  }, []);
}

/** Zona con sesión: sin sesión, al login. */
export default function AppLayout() {
  const { status } = useSession();
  if (status === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator size="large" color={colors.text} />
      </View>
    );
  }
  if (status === 'signed-out') return <Redirect href="/login" />;
  return <SignedIn />;
}

function SignedIn() {
  useOfferNotificationTaps();
  return (
    <Stack screenOptions={{ headerStyle: { backgroundColor: colors.card }, headerTintColor: colors.text, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="ofertas" options={{ title: 'Ofertas', presentation: 'modal' }} />
      <Stack.Screen name="envio/[id]" options={{ title: 'Envío' }} />
      <Stack.Screen name="entregar/[id]" options={{ title: 'Prueba de entrega' }} />
    </Stack>
  );
}
