import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Banner, Card, colors, Muted, Row, styles as ui, Title } from '@/components/ui';
import { api } from '@/lib/api';
import { Period, periodRange } from '@/lib/earnings';
import { formatDay, formatDistance, formatIsoDate, formatMoney, formatTime } from '@/lib/format';
import { useResource } from '@/lib/hooks';

const LABELS: Record<Period, string> = { today: 'Hoy', week: 'Esta semana', lastWeek: 'Semana pasada' };
const COD_METHODS: Record<string, string> = { cash: 'Efectivo', card_pos: 'Tarjeta (POS)', deuna_qr: 'DeUna (QR)' };

export default function EarningsScreen() {
  const [period, setPeriod] = useState<Period>('week');
  const range = periodRange(period);
  const earnings = useResource(() => api.earnings(range.from, range.to), { key: period });
  const e = earnings.data;
  // Si cambió la pestaña y aún no llegó la respuesta, no se muestran datos de otro período.
  const stale = e && (e.period.from !== range.from || e.period.to !== range.to);

  return (
    <ScrollView style={ui.screen} contentContainerStyle={ui.content} refreshControl={<RefreshControl refreshing={false} onRefresh={earnings.reload} />}>
      <View style={styles.tabs}>
        {(Object.keys(LABELS) as Period[]).map((p) => (
          <Pressable key={p} onPress={() => setPeriod(p)} style={[styles.tab, p === period && styles.tabActive]} accessibilityRole="tab" accessibilityState={{ selected: p === period }}>
            <Text style={[styles.tabText, p === period && styles.tabTextActive]}>{LABELS[p]}</Text>
          </Pressable>
        ))}
      </View>
      <Banner text={earnings.error} />
      {!e || stale ? (
        <Muted>{earnings.loading || stale ? 'Cargando…' : ''}</Muted>
      ) : (
        <>
          <Card>
            <Muted>{e.period.from === e.period.to ? formatIsoDate(e.period.from) : `${formatIsoDate(e.period.from)} – ${formatIsoDate(e.period.to)}`}</Muted>
            <Text style={styles.big}>{formatMoney(e.fees)}</Text>
            <Row label="Entregas" value={String(e.deliveries)} />
            {Number(e.bonusEstimate) > 0 ? <Row label="Bono por volumen (estimado)" value={formatMoney(e.bonusEstimate)} /> : null}
            <Row label="Hoy" value={`${e.today.deliveries} entregas · ${formatMoney(e.today.fees)}`} />
          </Card>

          <Card>
            <Title>Cobros contra entrega</Title>
            <Row label="Total cobrado" value={formatMoney(e.codCollected.total)} strong />
            {(['cash', 'card_pos', 'deuna_qr'] as const).map((m) => (Number(e.codCollected[m]) > 0 ? <Row key={m} label={COD_METHODS[m]} value={formatMoney(e.codCollected[m])} /> : null))}
            <Row label="Efectivo por entregar en bodega" value={formatMoney(e.codBalance)} />
            <Row label="Tope de efectivo disponible" value={formatMoney(e.codAvailable)} />
            <Muted>El efectivo se descuenta de tu liquidación semanal o lo entregas en bodega.</Muted>
          </Card>

          {e.byDay.length > 1 ? (
            <Card>
              <Title>Por día</Title>
              {e.byDay.map((d) => (
                <Row key={d.date} label={formatIsoDate(d.date)} value={`${d.deliveries} · ${formatMoney(d.fees)}`} />
              ))}
            </Card>
          ) : null}

          <Card>
            <Title>Entregas</Title>
            {e.items.length === 0 ? <Muted>Sin entregas en este período.</Muted> : null}
            {e.items.map((i) => (
              <View key={i.shipmentId} style={styles.item}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.itemTitle}>{i.orderNumber ?? 'Envío'}</Text>
                  <Muted>
                    {[`${formatDay(i.deliveredAt)} ${formatTime(i.deliveredAt)}`, formatDistance(i.distanceM), Number(i.codAmount) > 0 ? `cobro ${formatMoney(i.codAmount)}${i.codMethod ? ` (${COD_METHODS[i.codMethod]})` : ''}` : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </Muted>
                </View>
                <Text style={styles.itemFee}>{formatMoney(i.fee)}</Text>
              </View>
            ))}
          </Card>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', backgroundColor: colors.border, borderRadius: 12, padding: 4 },
  tab: { flex: 1, paddingVertical: 10, borderRadius: 9, alignItems: 'center' },
  tabActive: { backgroundColor: colors.card },
  tabText: { color: colors.muted, fontSize: 15, fontWeight: '600' },
  tabTextActive: { color: colors.text },
  big: { fontSize: 36, fontWeight: '900', color: colors.text },
  item: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, borderTopWidth: 1, borderColor: colors.border },
  itemTitle: { fontSize: 15, fontWeight: '600', color: colors.text },
  itemFee: { fontSize: 16, fontWeight: '700', color: colors.text },
});
