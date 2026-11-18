import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { RiderMap } from '@/components/RiderMap';
import { Badge, Banner, colors, Muted } from '@/components/ui';
import { useActiveShipments, useGpsStatus } from '@/lib/hooks';
import { pinsFor, STATUS_LABELS } from '@/lib/shipment-flow';

export default function MapScreen() {
  const shipments = useActiveShipments();
  const gps = useGpsStatus();
  const list = shipments.data ?? [];
  const me = gps.lastFix ? { lat: gps.lastFix.lat, lng: gps.lastFix.lng } : null;

  return (
    <View style={{ flex: 1 }}>
      <RiderMap pins={pinsFor(list)} me={me} style={{ flex: 1 }} />
      <View style={styles.sheet}>
        <Banner text={shipments.error} />
        <Muted>B = retiro en bodega · C = entrega al cliente</Muted>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingVertical: 8 }}>
          {list.length === 0 ? <Muted>Sin envíos en curso.</Muted> : null}
          {list.map((s) => (
            <Pressable key={s.id} style={styles.chip} onPress={() => router.push({ pathname: '/envio/[id]', params: { id: s.id } })}>
              <Text style={styles.chipTitle} numberOfLines={1}>
                {s.orderNumber ?? 'Envío'}
              </Text>
              <Text style={styles.chipText} numberOfLines={1}>
                {s.destination.label}
              </Text>
              <Badge text={STATUS_LABELS[s.status] ?? s.status} />
            </Pressable>
          ))}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { backgroundColor: colors.card, padding: 12, borderTopWidth: 1, borderColor: colors.border },
  chip: { width: 220, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 10, gap: 4 },
  chipTitle: { fontWeight: '700', color: colors.text, fontSize: 15 },
  chipText: { color: colors.text, fontSize: 14 },
});
