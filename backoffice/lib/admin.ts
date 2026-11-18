import type { Tone } from '@/components/ui/Badge';
import type { UserType } from './types';

/**
 * Administración: usuarios y roles (módulo IAM) y zonas de cobertura con sus franjas (Logística).
 * Tipos de las respuestas del API y helpers puros (etiquetas, validaciones) que se prueban sin UI.
 */

// ───────────────────────────── Usuarios ─────────────────────────────

export type UserStatus = 'pending' | 'active' | 'blocked' | 'anonymized';

/** Fila de GET /iam/users (UserAdminView). */
export interface AdminUser {
  id: string;
  type: UserType;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  status: UserStatus;
  mfaEnabled: boolean;
  /** Códigos de rol, ordenados. */
  roles: string[];
  lastLoginAt: string | null;
  createdAt: string;
}

/** GET /iam/users/:id: además, hasta cuándo está bloqueada por intentos fallidos. */
export interface AdminUserDetail extends AdminUser {
  lockedUntil: string | null;
}

/** 201 de POST /iam/users: la contraseña temporal se devuelve UNA sola vez. */
export interface CreatedStaffUser {
  user: AdminUser;
  temporaryPassword: string;
}

export interface CreateStaffUserInput {
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  roles: string[];
}

/** GET /iam/roles */
export interface Role {
  code: string;
  name: string;
  isSystem: boolean;
  permissions: string[];
}

/** GET /iam/users/:id/roles (y respuesta de PUT/DELETE). grantedBy es el id de quien lo asignó. */
export interface UserRole {
  code: string;
  name: string;
  grantedBy: string | null;
  grantedAt: string;
}

export interface UserFilters {
  q: string;
  type: '' | UserType;
  status: '' | 'active' | 'blocked' | 'pending';
  role: string;
}

export const USER_STATUS: Record<UserStatus, [string, Tone]> = {
  active: ['Activo', 'ok'],
  pending: ['Pendiente', 'warn'],
  blocked: ['Bloqueado', 'danger'],
  anonymized: ['Anonimizado', 'neutral'],
};

export const USER_TYPE_LABEL: Record<UserType, string> = {
  staff: 'Personal',
  customer: 'Cliente',
  rider: 'Motorizado',
};

/**
 * Tipo de usuario de cada rol del sistema (espejo de backend iam/domain/system-roles.ts). El API
 * solo asigna roles del sistema y responde 422 ROLE_NOT_ALLOWED_FOR_USER_TYPE si no calza; aquí
 * se usa para no ofrecer opciones que el servidor rechazaría.
 */
export const ROLE_USER_TYPE: Record<string, UserType> = {
  admin: 'staff',
  manager: 'staff',
  seller: 'staff',
  warehouse: 'staff',
  support: 'staff',
  logistics: 'staff',
  rider: 'rider',
  customer: 'customer',
};

/** Roles de la lista que se pueden asignar a un usuario de ese tipo. */
export function assignableRoles<R extends { code: string }>(roles: readonly R[], userType: UserType): R[] {
  return roles.filter((r) => ROLE_USER_TYPE[r.code] === userType);
}

/** Un usuario con rol admin debe configurar 2FA en su primer ingreso. */
export function requiresMfa(roles: readonly string[]): boolean {
  return roles.includes('admin');
}

/** Bloquear solo aplica a cuentas activas; desbloquear, a bloqueadas (si no, 422 USER_STATUS_NOT_MANAGEABLE). */
export function blockAction(status: UserStatus): 'block' | 'unblock' | null {
  if (status === 'active') return 'block';
  if (status === 'blocked') return 'unblock';
  return null;
}

/** ¿Sigue vigente el bloqueo temporal por intentos fallidos? */
export function isTemporarilyLocked(lockedUntil: string | null, now = new Date()): boolean {
  return !!lockedUntil && new Date(lockedUntil).getTime() > now.getTime();
}

export const PHONE_RE = /^\+?[0-9]{7,15}$/;

/** Validación del alta de personal (mismas reglas que CreateStaffUserDto). Devuelve el error o null. */
export function validateNewStaff(input: CreateStaffUserInput): string | null {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) return 'Ingresa un email válido.';
  if (!input.firstName.trim() || !input.lastName.trim()) return 'Nombre y apellido son obligatorios.';
  if (input.phone && !PHONE_RE.test(input.phone)) return 'El teléfono debe tener de 7 a 15 dígitos, con "+" opcional.';
  if (input.roles.length < 1) return 'Elige al menos un rol.';
  if (input.roles.length > 10) return 'Máximo 10 roles.';
  if (input.roles.some((r) => ROLE_USER_TYPE[r] !== 'staff')) return 'Solo se pueden asignar roles de personal.';
  return null;
}

// ───────────────────────────── Permisos ─────────────────────────────

export const MODULE_LABEL: Record<string, string> = {
  catalog: 'Catálogo',
  inventory: 'Inventario',
  orders: 'Pedidos',
  promotions: 'Promociones',
  giftcards: 'Promociones',
  payments: 'Pagos',
  logistics: 'Logística',
  billing: 'Facturación',
  returns: 'Devoluciones',
  notifications: 'Notificaciones',
  crm: 'Clientes (CRM)',
  support: 'Soporte',
  reports: 'Reportes',
  iam: 'Usuarios y accesos',
};

/** Nombre legible de cada permiso del catálogo (backend PERMISSIONS). */
export const PERMISSION_LABEL: Record<string, string> = {
  'inventory.read': 'Ver stock y bodegas',
  'inventory.warehouse.write': 'Crear y editar bodegas',
  'inventory.stock.write': 'Modificar stock',
  'inventory.adjust': 'Ajustes de inventario',
  'inventory.supplier.write': 'Gestionar proveedores',
  'inventory.purchase.write': 'Crear órdenes de compra',
  'inventory.purchase.receive': 'Recibir compras',
  'inventory.picking': 'Picking de pedidos',
  'orders.read': 'Ver pedidos',
  'orders.status.update': 'Cambiar estado de pedidos',
  'orders.cancel': 'Cancelar pedidos',
  'orders.payment.confirm': 'Confirmar pagos de pedidos',
  'orders.assisted.create': 'Crear pedidos asistidos',
  'promotions.read': 'Ver promociones',
  'promotions.write': 'Crear y editar promociones',
  'giftcards.read': 'Ver tarjetas de regalo',
  'giftcards.write': 'Emitir tarjetas de regalo',
  'payments.read': 'Ver pagos',
  'payments.transfer.verify': 'Verificar transferencias',
  'payments.refund.approve': 'Aprobar reembolsos',
  'payments.refund.complete': 'Completar reembolsos',
  'logistics.read': 'Ver logística y zonas',
  'logistics.zone.write': 'Editar zonas y franjas',
  'logistics.dispatch': 'Despachar envíos',
  'logistics.settlement.manage': 'Gestionar liquidaciones',
  'logistics.settlement.approve': 'Aprobar liquidaciones',
  'billing.read': 'Ver facturas',
  'returns.read': 'Ver devoluciones',
  'returns.approve': 'Aprobar devoluciones',
  'returns.inspect': 'Inspeccionar devoluciones',
  'notifications.read': 'Ver notificaciones',
  'notifications.templates.write': 'Editar plantillas de notificación',
  'crm.read': 'Ver clientes',
  'crm.loyalty.adjust': 'Ajustar puntos de fidelidad',
  'crm.tiers.write': 'Editar niveles de fidelidad',
  'catalog.product.write': 'Crear y editar productos',
  'catalog.reviews.moderate': 'Moderar reseñas',
  'catalog.questions.answer': 'Responder preguntas',
  'support.tickets.read': 'Ver tickets',
  'support.tickets.write': 'Responder tickets',
  'support.tickets.assign': 'Asignar tickets',
  'reports.sales.read': 'Reporte de ventas',
  'reports.delivery.read': 'Reporte de entregas',
  'reports.funnel.read': 'Embudo de conversión',
  'reports.export': 'Exportar reportes',
  'iam.roles.read': 'Ver roles',
  'iam.roles.assign': 'Asignar roles',
  'iam.mfa.reset': 'Resetear 2FA de otros',
  'iam.users.read': 'Ver usuarios',
  'iam.users.write': 'Crear, bloquear y resetear usuarios',
};

export function permissionLabel(code: string): string {
  return PERMISSION_LABEL[code] ?? code;
}

export function moduleOf(permission: string): string {
  const i = permission.indexOf('.');
  return i < 0 ? permission : permission.slice(0, i);
}

export interface PermissionGroup {
  module: string;
  label: string;
  permissions: string[];
}

/**
 * Agrupa por módulo (prefijo antes del primer punto) en el orden en que aparecen; los módulos con
 * el mismo nombre legible (promociones y tarjetas de regalo) quedan en un solo grupo.
 */
export function groupPermissions(permissions: Iterable<string>): PermissionGroup[] {
  const groups = new Map<string, PermissionGroup>();
  for (const p of new Set(permissions)) {
    const mod = moduleOf(p);
    const label = MODULE_LABEL[mod] ?? mod;
    const g = groups.get(label) ?? { module: mod, label, permissions: [] };
    g.permissions.push(p);
    groups.set(label, g);
  }
  return [...groups.values()];
}

/** Todos los permisos que aparecen en algún rol (para la matriz). */
export function allPermissions(roles: readonly Role[]): string[] {
  return [...new Set(roles.flatMap((r) => r.permissions))];
}

// ───────────────────────────── Zonas ─────────────────────────────

export const DELIVERY_MODES = ['rider', 'courier', 'both'] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export const DELIVERY_MODE_LABEL: Record<DeliveryMode, string> = {
  rider: 'Motorizado propio',
  courier: 'Courier',
  both: 'Motorizado y courier',
};

/** Posición GeoJSON [longitud, latitud]. */
export type Position = number[];
export type Ring = Position[];
export type PolygonCoords = Ring[];

export interface PolygonGeometry {
  type: 'Polygon';
  coordinates: PolygonCoords;
}
export interface MultiPolygonGeometry {
  type: 'MultiPolygon';
  coordinates: PolygonCoords[];
}
export type AreaGeometry = PolygonGeometry | MultiPolygonGeometry;

/** GET /logistics/zones (CoverageZone). El área llega siempre como MultiPolygon. Montos como string. */
export interface Zone {
  id: string;
  name: string;
  city: string;
  area: MultiPolygonGeometry;
  deliveryMode: DeliveryMode;
  /** Menor gana cuando un punto cae en zonas superpuestas. */
  priority: number;
  baseFee: string;
  feePerKm: string;
  feePerExtraKg: string;
  maxWeightKg: number;
  freeShippingThreshold: string | null;
  /** 'HH:MM' en America/Guayaquil. */
  sameDayCutoff: string | null;
  servingWarehouseId: string | null;
  active: boolean;
}

/** Cuerpo de POST/PATCH /logistics/zones (sin el área). */
export interface ZoneFields {
  name: string;
  city: string;
  deliveryMode: DeliveryMode;
  priority: number;
  baseFee: string;
  feePerKm: string;
  feePerExtraKg: string;
  maxWeightKg: number;
  freeShippingThreshold: string | null;
  sameDayCutoff: string | null;
  servingWarehouseId: string | null;
}

/** Bodega de GET /inventory/warehouses (solo lo que usa la pantalla de zonas). */
export interface WarehouseOption {
  id: string;
  code: string;
  name: string;
  city: string;
  shipsOnline: boolean;
  active: boolean;
}

/** Plantilla semanal de franjas. weekday: 0 = domingo … 6 = sábado. */
export interface SlotTemplate {
  id: string;
  zoneId: string;
  weekday: number;
  startTime: string;
  endTime: string;
  capacity: number;
  surcharge: string;
}

export interface SlotTemplateInput {
  weekday: number;
  startTime: string;
  endTime: string;
  capacity: number;
  surcharge: string;
}

/** Franja concreta generada a partir de las plantillas. */
export interface DeliverySlot {
  id: string;
  zoneId: string;
  slotDate: string;
  startsAt: string;
  endsAt: string;
  capacity: number;
  booked: number;
  cutoffAt: string;
  surcharge: string;
}

/** Tope de vértices de un área (backend logistics/domain/geo.ts MAX_AREA_VERTICES). */
export const MAX_AREA_VERTICES = 2000;

export const WEEKDAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'] as const;

export const MONEY_RE = /^\d{1,10}(\.\d{1,2})?$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Color de la zona en el mapa según su estado. */
export function zoneColor(zone: Pick<Zone, 'active'>): string {
  return zone.active ? '#2f6b3a' : '#8a8178';
}

function samePosition(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** Total de posiciones del área, como las cuenta el backend (incluye la que cierra cada anillo). */
export function countVertices(geometry: AreaGeometry): number {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.reduce((n, p) => n + p.reduce((m, ring) => m + ring.length, 0), 0);
}

/**
 * Valida el área antes de enviarla (el backend vuelve a validar, y PostGIS revisa además que no se
 * cruce): cada anillo cerrado (la última posición repite la primera), con al menos 3 vértices
 * distintos, coordenadas [lng, lat] en rango y no más de MAX_AREA_VERTICES posiciones en total.
 * Devuelve la lista de problemas (vacía si sirve).
 */
export function validateArea(geometry: AreaGeometry | null | undefined): string[] {
  if (!geometry) return ['Dibuja el área de la zona en el mapa.'];
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  if (!Array.isArray(polygons) || polygons.length === 0) return ['El área no tiene polígonos.'];
  const errors: string[] = [];
  polygons.forEach((polygon, pi) => {
    const name = polygons.length > 1 ? `Polígono ${pi + 1}` : 'El polígono';
    if (!Array.isArray(polygon) || polygon.length === 0) {
      errors.push(`${name} no tiene anillos.`);
      return;
    }
    polygon.forEach((ring, ri) => {
      const where = ri === 0 ? name : `${name}, hueco ${ri}`;
      if (!Array.isArray(ring) || ring.length === 0) {
        errors.push(`${where} está vacío.`);
        return;
      }
      if (ring.some((p) => !Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) {
        errors.push(`${where} tiene posiciones inválidas.`);
        return;
      }
      if (ring.some(([lng, lat]) => lng < -180 || lng > 180 || lat < -90 || lat > 90)) {
        errors.push(`${where} tiene coordenadas fuera de rango.`);
      }
      if (!samePosition(ring[0], ring[ring.length - 1])) errors.push(`${where} no está cerrado.`);
      const distinct = new Set(ring.map((p) => `${p[0]},${p[1]}`)).size;
      if (distinct < 3) errors.push(`${where} necesita al menos 3 vértices distintos.`);
    });
  });
  const total = countVertices(geometry);
  if (total > MAX_AREA_VERTICES) errors.push(`El área tiene ${total} vértices; el máximo es ${MAX_AREA_VERTICES}. Simplifica el dibujo.`);
  return errors;
}

/** Cierra un anillo si la última posición no repite la primera. */
export function closeRing(ring: Ring): Ring {
  if (ring.length === 0 || samePosition(ring[0], ring[ring.length - 1])) return ring;
  return [...ring, ring[0]];
}

/** Uno o varios polígonos dibujados → Polygon (si es uno) o MultiPolygon. null si no hay ninguno. */
export function toArea(polygons: readonly PolygonCoords[]): AreaGeometry | null {
  if (polygons.length === 0) return null;
  if (polygons.length === 1) return { type: 'Polygon', coordinates: polygons[0] };
  return { type: 'MultiPolygon', coordinates: [...polygons] };
}

/** Polígonos de un área (para cargarlos en el editor). */
export function polygonsOf(geometry: AreaGeometry): PolygonCoords[] {
  return geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
}

/** Caja [[oeste, sur], [este, norte]] que contiene las zonas (para encuadrar el mapa). */
export function boundsOf(geometries: readonly AreaGeometry[]): [[number, number], [number, number]] | null {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const g of geometries) {
    for (const polygon of polygonsOf(g)) {
      for (const [lng, lat] of polygon[0] ?? []) {
        w = Math.min(w, lng);
        e = Math.max(e, lng);
        s = Math.min(s, lat);
        n = Math.max(n, lat);
      }
    }
  }
  return Number.isFinite(w) ? [[w, s], [e, n]] : null;
}

/** "2.5" → "2.50" (el API acepta hasta 2 decimales; se normaliza para mostrar igual que se guarda). */
export function normalizeMoney(value: string): string {
  const t = value.trim().replace(',', '.');
  if (!MONEY_RE.test(t)) return t;
  return Number(t).toFixed(2);
}

/** Validación de los datos de la zona (mismas reglas que CreateZoneDto y assertValidZone). */
export function validateZoneFields(f: ZoneFields): string | null {
  if (f.name.trim().length < 2) return 'El nombre debe tener al menos 2 caracteres.';
  if (f.city.trim().length < 2) return 'La ciudad debe tener al menos 2 caracteres.';
  if (!Number.isInteger(f.priority) || f.priority < 0 || f.priority > 10000) return 'La prioridad debe ser un entero entre 0 y 10000.';
  for (const [label, v] of [
    ['Tarifa base', f.baseFee],
    ['Tarifa por km', f.feePerKm],
    ['Tarifa por kg extra', f.feePerExtraKg],
  ] as const) {
    if (!MONEY_RE.test(v)) return `${label}: monto inválido (usa punto y hasta 2 decimales).`;
  }
  if (f.freeShippingThreshold !== null && (!MONEY_RE.test(f.freeShippingThreshold) || Number(f.freeShippingThreshold) === 0)) {
    return 'El umbral de envío gratis debe ser un monto mayor que 0 (o vacío).';
  }
  if (!(f.maxWeightKg >= 0.1 && f.maxWeightKg <= 1000)) return 'El peso máximo debe estar entre 0,1 y 1000 kg.';
  if (f.sameDayCutoff !== null && !TIME_RE.test(f.sameDayCutoff)) return 'La hora de corte debe tener el formato HH:MM.';
  if (f.deliveryMode !== 'courier' && !f.servingWarehouseId) {
    return 'Una zona con motorizado propio necesita la bodega que la atiende.';
  }
  return null;
}

/** '14:00:00' → '14:00'. */
export function shortTime(value: string): string {
  return value.slice(0, 5);
}

/** Validación de una plantilla de franja (mismas reglas que assertValidTemplate). */
export function validateSlotTemplate(t: SlotTemplateInput): string | null {
  if (!Number.isInteger(t.weekday) || t.weekday < 0 || t.weekday > 6) return 'Elige un día de la semana.';
  if (!TIME_RE.test(t.startTime) || !TIME_RE.test(t.endTime)) return 'Las horas deben tener el formato HH:MM.';
  if (t.endTime <= t.startTime) return 'La franja debe terminar después de empezar.';
  if (!Number.isInteger(t.capacity) || t.capacity < 0 || t.capacity > 10000) return 'La capacidad debe ser un entero entre 0 y 10000.';
  if (!MONEY_RE.test(t.surcharge)) return 'Recargo inválido (usa punto y hasta 2 decimales).';
  return null;
}

/** Plantillas por día (lunes primero, como se lee una semana laboral) y hora de inicio. */
export function sortTemplates<T extends Pick<SlotTemplate, 'weekday' | 'startTime'>>(list: readonly T[]): T[] {
  const order = (d: number) => (d + 6) % 7;
  return [...list].sort((a, b) => order(a.weekday) - order(b.weekday) || a.startTime.localeCompare(b.startTime));
}

/** ¿Se generan franjas para esta zona? (el backend devuelve 0 si no hay motorizado o está inactiva). */
export function zoneServesRiders(zone: Pick<Zone, 'deliveryMode' | 'active'>): boolean {
  return zone.active && zone.deliveryMode !== 'courier';
}

/** 'AAAA-MM-DD' + n días (fechas de calendario, sin zona horaria). */
export function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
