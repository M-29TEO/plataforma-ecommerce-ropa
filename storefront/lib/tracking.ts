/** Lógica pura del seguimiento en vivo. */

export interface Point {
  lat: number;
  lng: number;
}

export const SHIPMENT_STEPS = [
  { status: 'pending', label: 'Pedido recibido' },
  { status: 'assigned', label: 'Motorizado asignado' },
  { status: 'picked_up', label: 'Retirado en bodega' },
  { status: 'in_transit', label: 'En camino' },
  { status: 'arriving', label: 'Llegando' },
  { status: 'delivered', label: 'Entregado' },
] as const;

/** Estados que se muestran en el paso de otro: aceptado por el motorizado = asignado; intento fallido = en camino. */
const STEP_ALIASES: Record<string, string> = { accepted: 'assigned', failed_attempt: 'in_transit' };

export function stepOf(status: string): number {
  const target = STEP_ALIASES[status] ?? status;
  const i = SHIPMENT_STEPS.findIndex((s) => s.status === target);
  return i === -1 ? 0 : i;
}

export const LIVE_STATUSES = new Set(['picked_up', 'in_transit', 'arriving']);

/** Mientras el pedido va en camino, el cliente ve el código que le dicta al motorizado al recibir. */
export function showDeliveryCode(t: { status: string; deliveryCode?: string | null }): boolean {
  return !!t.deliveryCode && (LIVE_STATUSES.has(t.status) || t.status === 'failed_attempt');
}

/** Interpolación lineal entre dos posiciones (t de 0 a 1), para que el marcador se deslice. */
export function lerp(a: Point, b: Point, t: number): Point {
  const k = Math.min(1, Math.max(0, t));
  return { lat: a.lat + (b.lat - a.lat) * k, lng: a.lng + (b.lng - a.lng) * k };
}

/** Suavizado ease-in-out para el desplazamiento del marcador. */
export function ease(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

/** Rectángulo que contiene todos los puntos, con margen. null si no hay puntos. */
export function bounds(points: Array<Point | null | undefined>): [[number, number], [number, number]] | null {
  const ps = points.filter((p): p is Point => !!p);
  if (ps.length === 0) return null;
  const lats = ps.map((p) => p.lat);
  const lngs = ps.map((p) => p.lng);
  return [
    [Math.min(...lngs), Math.min(...lats)],
    [Math.max(...lngs), Math.max(...lats)],
  ];
}

/** Recorrido reciente del motorizado: se agrega el punto si se movió algo y se limita el largo. */
export function appendTrail(trail: Point[], p: Point, max = 200): Point[] {
  const last = trail[trail.length - 1];
  if (last && Math.abs(last.lat - p.lat) < 1e-6 && Math.abs(last.lng - p.lng) < 1e-6) return trail;
  return [...trail, p].slice(-max);
}
