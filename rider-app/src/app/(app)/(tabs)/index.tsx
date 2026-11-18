import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { OfferCard } from '@/components/OfferCard';
import { Badge, Banner, Button, Card, colors, Muted, Row, styles as ui, Title } from '@/components/ui';
import { api } from '@/lib/api';
import { ApiError, errorMessage } from '@/lib/api-client';
import { formatDistance, formatDuration, formatMoney, formatSlot, formatTime, isPositiveAmount } from '@/lib/format';
import { useActiveShipments, useGpsStatus, useNow, useOffers } from '@/lib/hooks';
import type { PermissionProblem } from '@/lib/location-task';
import { useSession } from '@/lib/session';
import { STATUS_LABELS } from '@/lib/shipment-flow';
import type { Offer, Presence } from '@/lib/types';

const PERMISSION_TEXT: Record<Exclude<PermissionProblem, null>, string> = {
  services: 'Activa la ubicación (GPS) del teléfono para iniciar el turno.',
  foreground: 'La app necesita tu ubicación para iniciar el turno.',
  background: 'Elige "Permitir todo el tiempo" en la ubicación: así la central te ve aunque la app esté minimizada.',
};

export default function ShiftScreen() {
  const session = useSession();
  const profile = session.profile!;
  const shift = profile.shift?.status === 'active' ? profile.shift : null;
  const offers = useOffers(!!shift);
  const shipments = useActiveShipments();
  const gps = useGpsStatus();
  const now = useNow(15_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = async () => {
    await Promise.all([session.refreshProfile(), offers.reload(), shipments.reload()]);
  };

  const startShift = async () => {
    setBusy('start');
    setProblem(null);
    try {
      const p = await session.startShift();
      if (p) setProblem(PERMISSION_TEXT[p]);
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const endShift = () =>
    Alert.alert('Terminar turno', 'Dejarás de recibir ofertas y de enviar tu ubicación.', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Terminar',
        style: 'destructive',
        onPress: async () => {
          setBusy('end');
          try {
            const { summary } = await session.endShift();
            Alert.alert(
              'Turno terminado',
              `Entregas: ${summary.deliveries}\nGanancia: ${formatMoney(summary.fees)}\nEfectivo cobrado: ${formatMoney(summary.codCollected)}`,
            );
          } catch (e) {
            const msg =
              e instanceof ApiError && e.code === 'SHIFT_HAS_ACTIVE_SHIPMENTS' ? 'Tienes envíos en curso: entrégalos o avisa a logística antes de terminar.' : errorMessage(e);
            Alert.alert('No se pudo terminar el turno', msg);
          } finally {
            setBusy(null);
          }
        },
      },
    ]);

  const setPresence = async (presence: Presence) => {
    setBusy(presence);
    try {
      await api.setPresence(presence);
      await session.refreshProfile();
    } catch (e) {
      Alert.alert('No se pudo cambiar el estado', errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const accept = async (o: Offer) => {
    const shipment = await api.acceptOffer(o.id);
    await Promise.all([offers.reload(), shipments.reload()]);
    router.push({ pathname: '/envio/[id]', params: { id: shipment.id } });
  };
  const reject = async (o: Offer, reason?: string) => {
    await api.rejectOffer(o.id, reason);
    await offers.reload();
  };

  const logout = async () => {
    try {
      await session.logout();
    } catch (e) {
      Alert.alert('Cerrar sesión', errorMessage(e));
    }
  };

  const openOffers = offers.data ?? [];
  const active = shipments.data ?? [];

  return (
    <ScrollView style={ui.screen} contentContainerStyle={ui.content} refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} />}>
      <Card>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Title>{profile.name ?? profile.email}</Title>
            <Muted>
              {[vehicleLabel(profile.vehicleType), profile.plate, `★ ${Number(profile.ratingAvg).toFixed(1)}`].filter(Boolean).join(' · ')}
            </Muted>
          </View>
          <Badge text={shift ? presenceLabel(profile.presence) : 'Fuera de turno'} tone={shift ? (profile.presence === 'available' ? 'success' : 'warning') : 'neutral'} />
        </View>
      </Card>

      <Banner text={problem} tone="warning" />
      {problem ? <Button title="Abrir ajustes del teléfono" variant="secondary" onPress={() => void Linking.openSettings()} /> : null}

      {shift ? (
        <Card>
          <Row label="Turno desde" value={`${formatTime(shift.startedAt)} (${formatDuration(now - new Date(shift.startedAt).getTime())})`} />
          <Row label="Fin previsto" value={formatTime(shift.plannedEndAt)} />
          <Row
            label="GPS"
            value={gps.lastSentAt ? `Enviado ${formatTime(new Date(gps.lastSentAt))}${gps.pending ? ` · ${gps.pending} en cola` : ''}` : 'Esperando señal…'}
          />
          <Row label="Ofertas" value={session.ntfyConnected ? 'Conectado' : 'Reconectando…'} />
          {gps.error ? <Banner text={gps.error} tone="warning" /> : null}
          <View style={styles.actions}>
            {profile.presence === 'break' ? (
              <Button title="Volver a estar disponible" style={{ flex: 1 }} onPress={() => void setPresence('available')} loading={busy === 'available'} />
            ) : (
              <Button title="Pausa" variant="secondary" style={{ flex: 1 }} onPress={() => void setPresence('break')} loading={busy === 'break'} />
            )}
            <Button title="Terminar turno" variant="danger" style={{ flex: 1 }} onPress={endShift} loading={busy === 'end'} />
          </View>
        </Card>
      ) : (
        <Card>
          <Title>Sin turno activo</Title>
          <Muted>Al iniciar, la central recibe tu ubicación cada 10 segundos y empiezas a recibir ofertas de pedidos.</Muted>
          <Button title="Iniciar turno" onPress={startShift} loading={busy === 'start'} testID="start-shift" />
        </Card>
      )}

      {shift ? (
        <View style={{ gap: 12 }}>
          <View style={styles.sectionHeader}>
            <Text style={styles.section}>Ofertas</Text>
            {offers.error ? <Muted>{offers.error}</Muted> : null}
          </View>
          {openOffers.length === 0 ? <Muted>No hay ofertas por ahora. Te avisaremos con una notificación.</Muted> : null}
          {openOffers.map((o) => (
            <OfferCard key={o.id} offer={o} onAccept={accept} onReject={reject} />
          ))}
        </View>
      ) : null}

      <Text style={styles.section}>Envíos en curso</Text>
      {shipments.error ? <Banner text={shipments.error} /> : null}
      {active.length === 0 && !shipments.loading ? <Muted>No tienes envíos en curso.</Muted> : null}
      {active.map((s) => (
        <Pressable key={s.id} onPress={() => router.push({ pathname: '/envio/[id]', params: { id: s.id } })} accessibilityRole="button">
          <Card>
            <View style={styles.header}>
              <Text style={styles.order}>{s.orderNumber ? `Pedido ${s.orderNumber}` : 'Envío'}</Text>
              <Badge text={STATUS_LABELS[s.status] ?? s.status} tone={s.status === 'failed_attempt' ? 'danger' : 'neutral'} />
            </View>
            <Text style={{ fontSize: 16, color: colors.text }}>{s.destination.label}</Text>
            <Muted>{[s.slot ? formatSlot(s.slot) : null, s.distanceM !== null ? formatDistance(s.distanceM) : null].filter(Boolean).join(' · ')}</Muted>
            {isPositiveAmount(s.codAmount) ? <Badge text={`Cobrar ${formatMoney(s.codAmount)}`} tone="warning" /> : null}
          </Card>
        </Pressable>
      ))}

      <Card>
        <Row label="Efectivo por liquidar" value={formatMoney(profile.codBalance)} strong />
        <Row label="Puedes recibir hasta" value={formatMoney(profile.codAvailable)} />
        {Number(profile.codAvailable) <= 0 ? <Banner text="Llegaste a tu tope de efectivo: entrega lo cobrado en bodega para recibir pedidos contra entrega." tone="warning" /> : null}
      </Card>

      {!shift ? <Button title="Cerrar sesión" variant="secondary" onPress={logout} /> : null}
    </ScrollView>
  );
}

function presenceLabel(p: Presence): string {
  return { available: 'Disponible', busy: 'Ocupado', break: 'En pausa', offline: 'Desconectado' }[p];
}

function vehicleLabel(v: string): string {
  return ({ motorcycle: 'Moto', bicycle: 'Bicicleta', car: 'Auto', van: 'Furgoneta' } as Record<string, string>)[v] ?? v;
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  section: { fontSize: 20, fontWeight: '800', color: colors.text, marginTop: 8 },
  order: { fontSize: 17, fontWeight: '700', color: colors.text },
});
