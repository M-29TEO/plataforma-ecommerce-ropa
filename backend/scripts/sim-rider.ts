/**
 * Simulador del motorizado (solo desarrollo): toma un pedido con entrega por motorizado, lo asigna
 * al motorizado de demo (si no lo aceptó ya desde la app), lo retira en la bodega y lo lleva hasta el
 * destino enviando su posición GPS cada SIM_STEP_MS a la API, como la app del motorizado. Al final
 * entrega con prueba (multipart: foto y firma de 1×1 px y el código de entrega, que calcula con el
 * mismo secreto que la API: DELIVERY_OTP_SECRET o, en desarrollo, derivado de JWT_SECRET). Sirve
 * para ver el tracking en vivo del storefront (/seguimiento/<token>) sin la app.
 *
 *   npm run sim:rider -- <número de pedido> [código]   (p. ej. npm run sim:rider -- 1024 482913)
 *
 * El código de entrega es el que el cliente ve en /seguimiento (como si se lo dictara al motorizado);
 * sin él, el simulador lo calcula. Un código equivocado responde 422 y el envío sigue "llegando";
 * al volver a correrlo con el código correcto, entrega sin repetir la ruta.
 * Con la demo en Docker (docs/DEMO.md), dentro del contenedor de la API:
 *   docker compose exec -e NODE_ENV=development api node dist/scripts/sim-rider.js 1024 482913
 *
 * Variables: API_URL (por defecto http://localhost:3000/v1), SIM_STEP_MS (2000), SIM_RIDER_EMAIL
 * (moto@demo.test), OSRM_URL (si está, sigue la ruta por calles; si no, una curva suave en línea recta).
 * Usa la API con tokens firmados con JWT_SECRET (como token:dev) y lee la base solo para encontrar el envío.
 */
import { Client } from 'pg';
import { deliveryOtpCode } from '../libs/modules/logistics/domain/delivery-proof';
import { signAccessToken } from '../libs/shared-kernel/auth/auth-user';
import { deliveryOtpSecretFrom } from '../libs/shared-kernel/config/app-config';

/** PNG de 1×1 (sirve de foto y de firma: la API valida el tipo por magic bytes, no el contenido). */
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

interface Point {
  lat: number;
  lng: number;
}

const API = (process.env.API_URL || 'http://localhost:3000/v1').replace(/\/+$/, '');
const STEP_MS = Number(process.env.SIM_STEP_MS || 2000);
const RIDER_EMAIL = process.env.SIM_RIDER_EMAIL || 'moto@demo.test';
const MAX_STEPS = 60;
const ARRIVING_M = 400;

if (process.env.NODE_ENV === 'production') {
  console.error('sim:rider es solo para desarrollo');
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function distanceM(a: Point, b: Point): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bearing(a: Point, b: Point): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);
}

/** Ruta por calles (OSRM) o, sin OSRM, una curva suave entre los dos puntos. */
async function route(from: Point, to: Point): Promise<Point[]> {
  const osrm = process.env.OSRM_URL?.replace(/\/+$/, '');
  if (osrm) {
    try {
      const res = await fetch(`${osrm}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`);
      const body = (await res.json()) as { routes?: Array<{ geometry: { coordinates: [number, number][] } }> };
      const coords = body.routes?.[0]?.geometry.coordinates;
      if (coords && coords.length > 1) return coords.map(([lng, lat]) => ({ lat, lng }));
    } catch (error) {
      console.warn(`OSRM no respondió (${(error as Error).message}): uso una ruta aproximada`);
    }
  }
  const n = 40;
  // Desvío perpendicular de hasta ~8 % de la distancia: parece una ruta y no una regla.
  const dLat = to.lat - from.lat;
  const dLng = to.lng - from.lng;
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    const bend = Math.sin(Math.PI * t) * 0.08;
    return { lat: from.lat + dLat * t - dLng * bend, lng: from.lng + dLng * t + dLat * bend };
  });
}

/** Remuestrea la ruta en a lo sumo MAX_STEPS puntos equidistantes (terminando en el destino). */
function resample(path: Point[]): Point[] {
  const total = path.slice(1).reduce((sum, p, i) => sum + distanceM(path[i], p), 0);
  const step = Math.max(total / MAX_STEPS, 25);
  const out: Point[] = [path[0]];
  let carry = 0;
  for (let i = 1; i < path.length; i++) {
    const seg = distanceM(path[i - 1], path[i]);
    let pos = step - carry;
    while (pos <= seg) {
      const t = pos / seg;
      out.push({ lat: path[i - 1].lat + (path[i].lat - path[i - 1].lat) * t, lng: path[i - 1].lng + (path[i].lng - path[i - 1].lng) * t });
      pos += step;
    }
    carry = (carry + seg) % step;
  }
  out.push(path[path.length - 1]);
  return out;
}

async function api(method: string, path: string, token: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function main(): Promise<void> {
  const orderNumber = process.argv[2];
  if (!orderNumber || !/^\d+$/.test(orderNumber)) {
    console.error('Uso: npm run sim:rider -- <número de pedido> [código de entrega]');
    process.exit(1);
  }
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('Falta JWT_SECRET (backend/.env)');

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  let found;
  try {
    found = await db.query<{
      tenant_id: string;
      shipment_id: string;
      status: string;
      tracking_token: string;
      cod_amount: string;
      dest_lat: number;
      dest_lng: number;
      wh_lat: number;
      wh_lng: number;
      rider_id: string;
      rider_user_id: string;
      staff_id: string;
    }>(
      `SELECT o.tenant_id, s.id AS shipment_id, s.status, s.tracking_token, s.cod_amount,
              ST_Y(s.destination_location::geometry) AS dest_lat, ST_X(s.destination_location::geometry) AS dest_lng,
              ST_Y(w.location::geometry) AS wh_lat, ST_X(w.location::geometry) AS wh_lng,
              r.id AS rider_id, r.user_id AS rider_user_id,
              (SELECT id FROM iam.users WHERE tenant_id = o.tenant_id AND user_type = 'staff' ORDER BY created_at LIMIT 1) AS staff_id
         FROM sales.orders o
         JOIN logistics.shipments s ON s.order_id = o.id AND s.direction = 'outbound' AND s.carrier_type = 'rider'
         JOIN inventory.warehouses w ON w.id = s.origin_warehouse_id
         JOIN iam.users ru ON ru.tenant_id = o.tenant_id AND ru.email = $2
         JOIN logistics.riders r ON r.user_id = ru.id
        WHERE o.order_number = $1::bigint AND s.status NOT IN ('delivered', 'cancelled')
        ORDER BY s.created_at DESC LIMIT 1`,
      [orderNumber, RIDER_EMAIL],
    );
  } finally {
    await db.end();
  }
  const s = found.rows[0];
  if (!s) throw new Error(`El pedido ${orderNumber} no tiene un envío con motorizado pendiente (¿eligió "motorizado" en el checkout?) o no existe ${RIDER_EMAIL}`);

  const staff = signAccessToken({ id: s.staff_id, tenantId: s.tenant_id, type: 'staff', permissions: ['logistics.dispatch'] }, secret);
  const rider = signAccessToken({ id: s.rider_user_id, tenantId: s.tenant_id, type: 'rider', permissions: [] }, secret);
  const origin = { lat: s.wh_lat, lng: s.wh_lng };
  const dest = { lat: s.dest_lat, lng: s.dest_lng };
  console.log(`Seguimiento: /seguimiento/${s.tracking_token}`);

  let status = s.status;
  if (status === 'pending' || status === 'ready_for_pickup') {
    await api('POST', `/logistics/shipments/${s.shipment_id}/assign`, staff, { riderId: s.rider_id });
    status = 'assigned';
    console.log('Motorizado asignado');
    await sleep(STEP_MS);
  }
  if (status === 'assigned' || status === 'accepted') {
    await api('POST', '/rider/location', rider, origin);
    await api('POST', `/rider/shipments/${s.shipment_id}/status`, rider, { status: 'picked_up', ...origin });
    status = 'picked_up';
    console.log('Pedido retirado en bodega');
    await sleep(STEP_MS);
  }
  // Tras un intento fallido, el reintento vuelve a "en camino".
  if (status === 'picked_up' || status === 'failed_attempt') {
    await api('POST', `/rider/shipments/${s.shipment_id}/status`, rider, { status: 'in_transit' });
    status = 'in_transit';
    console.log('En camino');
  }

  // Ya "llegando" (p. ej. tras un código equivocado): sin repetir la ruta, solo se reintenta la entrega.
  const points = status === 'arriving' ? [] : resample(await route(origin, dest));
  if (status === 'arriving') console.log('Ya está llegando: se reintenta la entrega');
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const speedKmh = Math.round((distanceM(points[i - 1], p) / (STEP_MS / 1000)) * 3.6 * 10) / 10;
    const res = (await api('POST', '/rider/location', rider, { ...p, heading: bearing(points[i - 1], p), speedKmh: Math.min(speedKmh, 60), accuracyM: 8 })) as { liveShipments: string[] };
    const left = Math.round(distanceM(p, dest));
    process.stdout.write(`\r  ${i}/${points.length - 1} · faltan ${left} m · en vivo: ${res.liveShipments.length}   `);
    if (status === 'in_transit' && left <= ARRIVING_M) {
      await api('POST', `/rider/shipments/${s.shipment_id}/status`, rider, { status: 'arriving', ...p });
      status = 'arriving';
      process.stdout.write('\n  Llegando\n');
    }
    await sleep(STEP_MS);
  }
  const form = new FormData();
  form.append('lat', String(dest.lat));
  form.append('lng', String(dest.lng));
  form.append('receiverName', 'Cliente demo');
  form.append('otp', process.argv[3] || deliveryOtpCode(deliveryOtpSecretFrom(secret), s.shipment_id));
  if (Number(s.cod_amount) > 0) {
    form.append('codCollected', s.cod_amount);
    form.append('codMethod', 'cash');
  }
  form.append('photo', new Blob([new Uint8Array(PNG_1X1)], { type: 'image/png' }), 'entrega.png');
  form.append('signature', new Blob([new Uint8Array(PNG_1X1)], { type: 'image/png' }), 'firma.png');
  const res = await fetch(`${API}/rider/shipments/${s.shipment_id}/deliver`, { method: 'POST', headers: { Authorization: `Bearer ${rider}` }, body: form });
  if (!res.ok) throw new Error(`POST /rider/shipments/${s.shipment_id}/deliver → ${res.status}: ${await res.text()}`);
  console.log('\nEntregado');
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
