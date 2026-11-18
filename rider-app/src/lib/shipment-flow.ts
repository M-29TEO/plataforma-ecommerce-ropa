import type { GeoPoint, RiderSettableStatus, RiderShipment, ShipmentStatus } from './types';

/**
 * Flujo del envío visto desde la app (espejo de SHIPMENT_TRANSITIONS del backend): qué botones
 * ofrecer en cada estado y hacia dónde navegar (retiro en bodega o entrega al cliente).
 */
export type ShipmentAction =
  | { kind: 'status'; to: RiderSettableStatus; label: string; confirm?: string }
  | { kind: 'deliver'; label: string }
  | { kind: 'fail'; label: string };

export const STATUS_LABELS: Record<ShipmentStatus, string> = {
  pending: 'Pendiente',
  ready_for_pickup: 'Listo para retirar',
  assigned: 'Asignado',
  accepted: 'Aceptado',
  picked_up: 'Retirado',
  in_transit: 'En camino',
  arriving: 'Llegando',
  delivered: 'Entregado',
  failed_attempt: 'Intento fallido',
  returned_to_origin: 'Devuelto a bodega',
  cancelled: 'Cancelado',
};

/** Estados en que el envío sigue en manos del motorizado. */
export const ACTIVE_STATUSES: readonly ShipmentStatus[] = ['assigned', 'accepted', 'picked_up', 'in_transit', 'arriving', 'failed_attempt'];

export function actionsFor(status: ShipmentStatus): ShipmentAction[] {
  switch (status) {
    case 'assigned':
    case 'accepted':
      return [{ kind: 'status', to: 'picked_up', label: 'Retiré el paquete', confirm: '¿Ya tienes el paquete contigo?' }];
    case 'picked_up':
      return [{ kind: 'status', to: 'in_transit', label: 'Salir hacia el cliente' }];
    case 'in_transit':
      return [
        { kind: 'status', to: 'arriving', label: 'Estoy llegando' },
        { kind: 'deliver', label: 'Entregar' },
        { kind: 'fail', label: 'No pude entregar' },
      ];
    case 'arriving':
      return [
        { kind: 'deliver', label: 'Entregar' },
        { kind: 'fail', label: 'No pude entregar' },
      ];
    case 'failed_attempt':
      return [{ kind: 'status', to: 'in_transit', label: 'Reintentar entrega' }];
    default:
      return [];
  }
}

/** Antes del retiro se navega a la bodega; después, al cliente. */
export function navigationTarget(s: Pick<RiderShipment, 'status' | 'pickup' | 'destination'>): { point: GeoPoint; label: string } | null {
  const toPickup = s.status === 'assigned' || s.status === 'accepted';
  if (toPickup) return s.pickup?.location ? { point: s.pickup.location, label: s.pickup.name } : null;
  return s.destination.location ? { point: s.destination.location, label: s.destination.label } : null;
}

export const FAIL_REASONS = ['Cliente ausente', 'Dirección incorrecta', 'Cliente rechazó el pedido', 'Zona insegura', 'Sin efectivo para el cobro'] as const;

/** Código de entrega: 4 dígitos que el cliente ve en su seguimiento. */
export function isValidOtp(code: string): boolean {
  return /^\d{4}$/.test(code);
}

export interface MapPin {
  id: string;
  point: GeoPoint;
  kind: 'pickup' | 'dropoff';
  label: string;
}

/** Pin de cada envío: la bodega antes del retiro, el cliente después. */
export function pinsFor(list: RiderShipment[]): MapPin[] {
  const pins: MapPin[] = [];
  for (const s of list) {
    const toPickup = s.status === 'assigned' || s.status === 'accepted';
    if (toPickup && s.pickup?.location) pins.push({ id: `p-${s.id}`, point: s.pickup.location, kind: 'pickup', label: s.pickup.name });
    else if (s.destination.location) pins.push({ id: `d-${s.id}`, point: s.destination.location, kind: 'dropoff', label: s.destination.label });
  }
  return pins;
}
