import { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { errorMessage } from '@/lib/api-client';
import { formatDistance, formatMoney, formatSlot, isPositiveAmount, secondsLeft } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import type { Offer } from '@/lib/types';
import { ChoiceSheet } from './ChoiceSheet';
import { Badge, Button, Card, colors, Muted } from './ui';

const REJECT_REASONS = ['Estoy lejos', 'Ya llevo muchos pedidos', 'Problema con el vehículo', 'Otro motivo'];

/** Oferta con cuenta regresiva: aceptar o rechazar antes de que venza (luego pasa a otro motorizado). */
export function OfferCard({ offer, onAccept, onReject }: { offer: Offer; onAccept: (o: Offer) => Promise<void>; onReject: (o: Offer, reason?: string) => Promise<void> }) {
  const now = useNow();
  const left = secondsLeft(offer.expiresAt, now);
  const [busy, setBusy] = useState<'accept' | 'reject' | null>(null);
  const [choosing, setChoosing] = useState(false);

  const run = async (kind: 'accept' | 'reject', fn: () => Promise<void>) => {
    setBusy(kind);
    try {
      await fn();
    } catch (e) {
      Alert.alert(kind === 'accept' ? 'No se pudo aceptar' : 'No se pudo rechazar', errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const reject = (reason: string) => {
    setChoosing(false);
    void run('reject', () => onReject(offer, reason === 'Otro motivo' ? undefined : reason));
  };

  return (
    <Card style={left === 0 ? { opacity: 0.6 } : undefined}>
      <View style={styles.header}>
        <Text style={styles.fee}>{formatMoney(offer.estimatedFee)}</Text>
        <Badge text={left > 0 ? `${left} s` : 'Vencida'} tone={left > 10 ? 'warning' : 'danger'} />
      </View>
      <Text style={styles.line}>
        <Text style={styles.tag}>Retiro </Text>
        {offer.pickup.name}
      </Text>
      <Text style={styles.line}>
        <Text style={styles.tag}>Entrega </Text>
        {offer.dropoff.label || 'Dirección del cliente'}
      </Text>
      <Muted>
        {[offer.distanceM !== null ? formatDistance(offer.distanceM) : null, offer.slot ? formatSlot(offer.slot) : null].filter(Boolean).join(' · ')}
      </Muted>
      {isPositiveAmount(offer.codAmount) ? <Badge text={`Cobrar ${formatMoney(offer.codAmount)} contra entrega`} tone="warning" /> : null}
      <View style={styles.actions}>
        <Button title="Rechazar" variant="secondary" style={{ flex: 1 }} onPress={() => setChoosing(true)} disabled={left === 0 || busy !== null} loading={busy === 'reject'} />
        <Button title="Aceptar" variant="success" style={{ flex: 2 }} onPress={() => void run('accept', () => onAccept(offer))} disabled={left === 0 || busy !== null} loading={busy === 'accept'} />
      </View>
      <ChoiceSheet
        visible={choosing}
        title="¿Por qué la rechazas?"
        message="La oferta pasará a otro motorizado."
        options={REJECT_REASONS}
        onChoose={reject}
        onCancel={() => setChoosing(false)}
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  fee: { fontSize: 26, fontWeight: '800', color: colors.text },
  line: { fontSize: 16, color: colors.text },
  tag: { fontWeight: '700' },
  actions: { flexDirection: 'row', gap: 10, marginTop: 6 },
});
