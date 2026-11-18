import { Linking, Platform } from 'react-native';
import type { GeoPoint } from './types';

/**
 * Abrir la navegación paso a paso en la app que el motorizado tenga (Organic Maps, OsmAnd, Google
 * Maps…): Android resuelve el intent geo: y deja elegir. Sin ninguna app de mapas, se abre la
 * ruta de OpenStreetMap (OSRM) en el navegador.
 */
export function geoUri(p: GeoPoint, label: string): string {
  const q = `${p.lat},${p.lng}(${label.replace(/[()]/g, ' ').trim() || 'Destino'})`;
  return `geo:${p.lat},${p.lng}?q=${encodeURIComponent(q)}`;
}

export function osmDirectionsUrl(to: GeoPoint, from?: GeoPoint | null): string {
  const route = `${from ? `${from.lat},${from.lng}` : ''};${to.lat},${to.lng}`;
  return `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${encodeURIComponent(route)}`;
}

export async function openNavigation(to: GeoPoint, label: string, from?: GeoPoint | null): Promise<void> {
  if (Platform.OS === 'android') {
    try {
      await Linking.openURL(geoUri(to, label));
      return;
    } catch {
      // Sin app que maneje geo: → navegador.
    }
  }
  await Linking.openURL(osmDirectionsUrl(to, from));
}

export function callPhone(phone: string): Promise<void> {
  return Linking.openURL(`tel:${phone.replace(/[^\d+]/g, '')}`);
}
