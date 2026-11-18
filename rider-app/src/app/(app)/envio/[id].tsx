import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ChoiceSheet } from '@/components/ChoiceSheet';
import { RiderMap } from '@/components/RiderMap';
import { Badge, Banner, Button, Card, colors, Muted, Row, styles as ui } from '@/components/ui';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/api-client';
import { formatDistance, formatMoney, formatSlot, formatTime, isPositiveAmount } from '@/lib/format';
import { useGpsStatus, useResource } from '@/lib/hooks';
import { currentPoint } from '@/lib/location-task';
import { callPhone, openNavigation } from '@/lib/navigation';
import { actionsFor, FAIL_REASONS, navigationTarget, ShipmentAction, STATUS_LABELS } from '@/lib/shipment-flow';
import type { RiderSettableStatus } from '@/lib/types';
import type { MapPin } from '@/lib/shipment-flow';

/** Detalle del envío: mapa, navegación, datos de entrega y botones del siguiente estado. */
export default function ShipmentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const shipment = useResource(() => api.shipment(id), { key: id });
  const gps = useGpsStatus();
  const [busy, setBusy] = useState<string | null>(null);
  const [choosingReason, setChoosingReason] = useState(false);
  const s = shipment.data;

  if (!s) {
    return (
      <View style={[ui.screen, ui.content]}>
        <Banner text={shipment.error} />
        {!shipment.error ? <Muted>Cargando…</Muted> : null}
      </View>
    );
  }

  const me = gps.lastFix ? { lat: gps.lastFix.lat, lng: gps.lastFix.lng } : null;
  const pins: MapPin[] = [];
  if (s.pickup?.location) pins.push({ id: 'pickup', point: s.pickup.location, kind: 'pickup', label: s.pickup.name });
  if (s.destination.location) pins.push({ id: 'dropoff', point: s.destination.location, kind: 'dropoff', label: s.destination.label });
  const target = navigationTarget(s);
  const toPickup = s.status === 'assigned' || s.status === 'accepted';

  const changeStatus = async (to: RiderSettableStatus, reason?: string) => {
    setBusy(to);
    try {
      await api.setStatus(s.id, to, await currentPoint(), reason);
      await shipment.reload();
    } catch (e) {
      Alert.alert('No se pudo actualizar', errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const run = (a: ShipmentAction) => {
    if (a.kind === 'deliver') return router.push({ pathname: '/entregar/[id]', params: { id: s.id } });
    if (a.kind === 'fail') return setChoosingReason(true);
    if (a.confirm) {
      return Alert.alert(a.label, a.confirm, [
        { text: 'No', style: 'cancel' },
        { text: 'Sí', onPress: () => void changeStatus(a.to) },
      ]);
    }
    void changeStatus(a.to);
  };

  const phone = typeof s.destination.phone === 'string' ? s.destination.phone : null;
  const recipient = typeof s.destination.recipientName === 'string' ? s.destination.recipientName : null;
  const reference = typeof s.destination.reference === 'string' ? s.destination.reference : null;

  return (
    <ScrollView style={ui.screen} contentContainerStyle={ui.content}>
      <Stack.Screen options={{ title: s.orderNumber ? `Pedido ${s.orderNumber}` : 'Envío' }} />
      <RiderMap pins={pins} me={me} style={styles.map} />
      {target ? (
        <Button title={toPickup ? 'Navegar a la bodega' : 'Navegar al cliente'} onPress={() => void openNavigation(target.point, target.label, me)} />
      ) : (
        <Banner text="El destino no tiene ubicación en el mapa: guíate por la dirección." tone="warning" />
      )}

      <Card>
        <View style={styles.header}>
          <Text style={styles.title}>{STATUS_LABELS[s.status] ?? s.status}</Text>
          {s.attempts > 0 ? <Badge text={`Intentos: ${s.attempts}`} tone="warning" /> : null}
        </View>
        {s.pickup ? <Row label="Retiro" value={s.pickup.name} /> : null}
        <Row label="Entrega" value={s.destination.label} />
        {reference ? <Row label="Referencia" value={reference} /> : null}
        {recipient ? <Row label="Recibe" value={recipient} /> : null}
        {s.slot ? <Row label="Franja" value={formatSlot(s.slot)} /> : null}
        {s.distanceM !== null ? <Row label="Distancia" value={formatDistance(s.distanceM)} /> : null}
        <Row label="Tu ganancia" value={formatMoney(s.estimatedFee)} />
        {isPositiveAmount(s.codAmount) ? <Row label="Cobrar contra entrega" value={formatMoney(s.codAmount)} strong /> : null}
        {s.deliveredAt ? <Row label="Entregado" value={formatTime(s.deliveredAt)} /> : null}
      </Card>

      {phone ? <Button title={`Llamar a ${recipient ?? 'el cliente'}`} variant="secondary" onPress={() => void callPhone(phone)} /> : null}

      {actionsFor(s.status).map((a) => (
        <Button
          key={a.kind === 'status' ? a.to : a.kind}
          title={a.label}
          variant={a.kind === 'deliver' ? 'success' : a.kind === 'fail' ? 'danger' : 'primary'}
          onPress={() => run(a)}
          loading={a.kind === 'status' ? busy === a.to : a.kind === 'fail' && busy === 'failed_attempt'}
          disabled={busy !== null}
        />
      ))}
      {s.requiresOtp && (s.status === 'in_transit' || s.status === 'arriving') ? (
        <Muted>Al entregar, pide al cliente el código de 4 dígitos que ve en su seguimiento.</Muted>
      ) : null}
      <ChoiceSheet
        visible={choosingReason}
        title="¿Qué pasó?"
        message="El cliente recibirá un aviso y podrás reintentar la entrega."
        options={FAIL_REASONS}
        onChoose={(r) => {
          setChoosingReason(false);
          void changeStatus('failed_attempt', r);
        }}
        onCancel={() => setChoosingReason(false)}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  map: { height: 260, borderRadius: 14 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 20, fontWeight: '800', color: colors.text },
});
