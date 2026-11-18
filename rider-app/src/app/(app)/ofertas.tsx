import { router } from 'expo-router';
import { RefreshControl, ScrollView } from 'react-native';
import { OfferCard } from '@/components/OfferCard';
import { Banner, Button, Muted, styles as ui } from '@/components/ui';
import { api } from '@/lib/api';
import { useOffers } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { Offer } from '@/lib/types';

/** Se abre desde la notificación de una oferta (modarider://ofertas). */
export default function OffersScreen() {
  const { profile } = useSession();
  const onShift = profile?.shift?.status === 'active';
  const offers = useOffers(onShift);
  const list = offers.data ?? [];

  const accept = async (o: Offer) => {
    const shipment = await api.acceptOffer(o.id);
    router.replace({ pathname: '/envio/[id]', params: { id: shipment.id } });
  };
  const reject = async (o: Offer, reason?: string) => {
    await api.rejectOffer(o.id, reason);
    await offers.reload();
  };

  return (
    <ScrollView style={ui.screen} contentContainerStyle={ui.content} refreshControl={<RefreshControl refreshing={false} onRefresh={offers.reload} />}>
      {!onShift ? <Banner text="Inicia tu turno para recibir ofertas." tone="warning" /> : null}
      <Banner text={offers.error} />
      {onShift && !offers.loading && list.length === 0 ? <Muted>La oferta ya venció o la tomó otro motorizado.</Muted> : null}
      {list.map((o) => (
        <OfferCard key={o.id} offer={o} onAccept={accept} onReject={reject} />
      ))}
      <Button title="Volver" variant="secondary" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
    </ScrollView>
  );
}
