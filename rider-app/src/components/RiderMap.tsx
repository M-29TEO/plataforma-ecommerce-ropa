import { Camera, Map, Marker, UserLocation } from '@maplibre/maplibre-react-native';
import { useMemo } from 'react';
import { StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { DEFAULT_CENTER } from '@/lib/config';
import { boundsFor } from '@/lib/geo';
import { mapStyle } from '@/lib/map-style';
import type { MapPin } from '@/lib/shipment-flow';
import type { GeoPoint } from '@/lib/types';
import { colors } from './ui';

export type { MapPin };

const PIN = {
  pickup: { bg: colors.accent, letter: 'B' },
  dropoff: { bg: colors.success, letter: 'C' },
};

/**
 * Mapa de MapLibre Native (teselas de OpenStreetMap o PMTiles propios; nada de servicios pagos).
 * Encuadra los pines y la posición del motorizado; el punto azul nativo es su ubicación.
 */
export function RiderMap({ pins, me, style }: { pins: MapPin[]; me?: GeoPoint | null; style?: StyleProp<ViewStyle> }) {
  const styleSpec = useMemo(() => mapStyle(), []);
  const bounds = boundsFor([...pins.map((p) => p.point), ...(me ? [me] : [])]);
  const center = me ?? pins[0]?.point ?? DEFAULT_CENTER;

  return (
    <View style={[styles.wrap, style]}>
      <Map style={StyleSheet.absoluteFill} mapStyle={styleSpec} logo={false} attribution attributionPosition={{ bottom: 8, right: 8 }} compass={false}>
        {bounds && pins.length + (me ? 1 : 0) > 1 ? (
          <Camera bounds={bounds} padding={{ top: 60, right: 50, bottom: 60, left: 50 }} duration={600} />
        ) : (
          <Camera center={[center.lng, center.lat]} zoom={15} duration={600} />
        )}
        <UserLocation animated accuracy heading />
        {pins.map((p) => (
          <Marker key={p.id} id={p.id} lngLat={[p.point.lng, p.point.lat]} anchor="bottom">
            <View style={styles.pinWrap} accessibilityLabel={p.label}>
              <View style={[styles.pin, { backgroundColor: PIN[p.kind].bg }]}>
                <Text style={styles.pinText}>{PIN[p.kind].letter}</Text>
              </View>
              <View style={[styles.pinTail, { borderTopColor: PIN[p.kind].bg }]} />
            </View>
          </Marker>
        ))}
      </Map>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden', backgroundColor: '#E5E7EB' },
  pinWrap: { alignItems: 'center' },
  pin: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#FFFFFF' },
  pinText: { color: '#FFFFFF', fontWeight: '800', fontSize: 15 },
  pinTail: { width: 0, height: 0, borderLeftWidth: 6, borderRightWidth: 6, borderTopWidth: 8, borderLeftColor: 'transparent', borderRightColor: 'transparent' },
});
