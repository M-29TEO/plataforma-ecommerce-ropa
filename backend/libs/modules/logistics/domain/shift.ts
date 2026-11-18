import { ConflictError, ValidationError } from '../../../shared-kernel';

/**
 * Turnos del motorizado (logistics.rider_shifts). Solo con un turno activo recibe ofertas del
 * despacho automático. Al iniciar: si tiene un turno programado ('scheduled') que cubre la hora
 * actual, se activa ese; si no, se crea uno a demanda de RIDER_SHIFT_DEFAULT_HOURS. Al terminar,
 * ends_at queda en la hora real de cierre y el turno pasa a 'completed'.
 */
export type ShiftStatus = 'scheduled' | 'active' | 'completed' | 'no_show';

export interface ShiftRecord {
  id: string;
  riderId: string;
  zoneId: string | null;
  startsAt: Date;
  endsAt: Date;
  status: ShiftStatus;
  checkedInAt: Date | null;
}

export interface ShiftView {
  id: string;
  status: 'active' | 'completed';
  startedAt: string;
  plannedEndAt: string;
  endedAt: string | null;
}

/** Turno programado que cubre `now` (si hay varios, el que empezó antes). */
export function scheduledShiftCovering(shifts: ShiftRecord[], now: Date): ShiftRecord | null {
  const t = now.getTime();
  return (
    shifts
      .filter((s) => s.status === 'scheduled' && s.startsAt.getTime() <= t && t < s.endsAt.getTime())
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0] ?? null
  );
}

export function onDemandShiftWindow(now: Date, hours: number): { startsAt: Date; endsAt: Date } {
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) throw new ValidationError('INVALID_SHIFT_HOURS', 'Un turno dura entre 1 y 24 horas');
  return { startsAt: now, endsAt: new Date(now.getTime() + hours * 3_600_000) };
}

export function shiftView(s: ShiftRecord): ShiftView {
  const completed = s.status === 'completed';
  return {
    id: s.id,
    status: completed ? 'completed' : 'active',
    startedAt: (s.checkedInAt ?? s.startsAt).toISOString(),
    plannedEndAt: s.endsAt.toISOString(),
    endedAt: completed ? s.endsAt.toISOString() : null,
  };
}

/** Para terminar el turno no puede llevar paquetes ni tener envíos aceptados sin entregar. */
export function assertCanEndShift(activeShipmentIds: string[]): void {
  if (activeShipmentIds.length > 0) throw new ShiftHasActiveShipmentsError(activeShipmentIds);
}

export class ShiftAlreadyActiveError extends ConflictError {
  constructor(shiftId: string) {
    super('SHIFT_ALREADY_ACTIVE', 'Ya tienes un turno activo', { shiftId });
  }
}

export class NoActiveShiftError extends ConflictError {
  constructor() {
    super('NO_ACTIVE_SHIFT', 'No tienes un turno activo');
  }
}

export class ShiftHasActiveShipmentsError extends ConflictError {
  constructor(shipmentIds: string[]) {
    super('SHIFT_HAS_ACTIVE_SHIPMENTS', 'Entrega (o devuelve a bodega) tus envíos antes de terminar el turno', { shipmentIds });
  }
}
