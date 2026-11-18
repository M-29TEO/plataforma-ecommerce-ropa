import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { api } from './api';
import { errorMessage } from './api-client';
import { GPS_INTERVAL_MS } from './config';
import { gpsEvents, GpsStatus, offerEvents } from './events';
import { GpsQueue, RawLocation, toFix } from './gps-queue';
import { notifyNewOffer } from './notifications';

/**
 * GPS del turno en segundo plano: expo-location con un servicio en primer plano de Android (la
 * notificación fija "Turno activo") entrega posiciones aunque la app esté minimizada o la
 * pantalla apagada, y esta tarea las envía a POST /rider/location cada ~10 s.
 *
 * Este archivo se importa desde el layout raíz: la tarea debe definirse al cargar el bundle,
 * también cuando Android relanza la app solo para entregarle posiciones.
 */
export const LOCATION_TASK = 'moda-rider-location';

const status: GpsStatus = { lastFix: null, lastSentAt: null, pending: 0, error: null };
let lastOpenOffers = 0;

const queue = new GpsQueue((fix) =>
  api.location({
    lat: fix.lat,
    lng: fix.lng,
    heading: fix.heading,
    speedKmh: fix.speedKmh,
    accuracyM: fix.accuracyM,
    recordedAt: new Date(fix.timestamp).toISOString(),
  }),
);

export function gpsStatus(): GpsStatus {
  return { ...status };
}

export async function handleLocations(locations: RawLocation[]): Promise<void> {
  const fixes = locations.map(toFix);
  if (fixes.length > 0) {
    const last = fixes[fixes.length - 1];
    status.lastFix = { lat: last.lat, lng: last.lng, timestamp: last.timestamp };
  }
  queue.add(fixes);
  const result = await queue.flush();
  if (result.sent > 0) {
    status.lastSentAt = Date.now();
    status.error = null;
  } else if (queue.size > 0) {
    status.error = 'Sin conexión: las posiciones se enviarán al recuperar la señal';
  }
  if (result.sessionExpired) {
    status.error = 'Tu sesión venció: vuelve a iniciar sesión';
    await stopShiftTracking();
  }
  status.pending = queue.size;
  gpsEvents.emit(gpsStatus());

  if (result.openOffers !== null) {
    if (result.openOffers > 0 && lastOpenOffers === 0) {
      offerEvents.emit({ source: 'gps' });
      await notifyNewOffer();
    }
    lastOpenOffers = result.openOffers;
  }
}

if (!TaskManager.isTaskDefined(LOCATION_TASK)) {
  TaskManager.defineTask<{ locations: Location.LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
    if (error) {
      status.error = error.message;
      gpsEvents.emit(gpsStatus());
      return;
    }
    if (data?.locations?.length) {
      await handleLocations(data.locations).catch((e) => {
        status.error = errorMessage(e);
        gpsEvents.emit(gpsStatus());
      });
    }
  });
}

export type PermissionProblem = 'foreground' | 'background' | 'services' | null;

/** Pide permisos (primero "mientras se usa", luego "todo el tiempo", como exige Android 11+). */
export async function ensureLocationPermissions(): Promise<PermissionProblem> {
  if (!(await Location.hasServicesEnabledAsync())) return 'services';
  const fg = await Location.requestForegroundPermissionsAsync();
  if (!fg.granted) return 'foreground';
  const bg = await Location.requestBackgroundPermissionsAsync();
  if (!bg.granted) return 'background';
  return null;
}

export async function startShiftTracking(): Promise<void> {
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false)) return;
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.High,
    timeInterval: GPS_INTERVAL_MS,
    distanceInterval: 0,
    deferredUpdatesInterval: GPS_INTERVAL_MS,
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.AutomotiveNavigation,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'Turno activo',
      notificationBody: 'Moda Motorizado está enviando tu ubicación a la central',
      notificationColor: '#111827',
      killServiceOnDestroy: false,
    },
  });
}

export async function stopShiftTracking(): Promise<void> {
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false)) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  }
  lastOpenOffers = 0;
}

export function isTracking(): Promise<boolean> {
  return Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
}

/** Posición para un cambio de estado o la entrega: la del turno si es reciente, si no una nueva. */
export async function currentPoint(maxAgeMs = 30_000): Promise<{ lat: number; lng: number } | null> {
  if (status.lastFix && Date.now() - status.lastFix.timestamp < maxAgeMs) return { lat: status.lastFix.lat, lng: status.lastFix.lng };
  try {
    const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    return { lat: p.coords.latitude, lng: p.coords.longitude };
  } catch {
    return status.lastFix ? { lat: status.lastFix.lat, lng: status.lastFix.lng } : null;
  }
}
