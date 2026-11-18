import { describe, expect, it } from 'vitest';
import {
  assignableRoles,
  blockAction,
  boundsOf,
  closeRing,
  countVertices,
  groupPermissions,
  isTemporarilyLocked,
  MAX_AREA_VERTICES,
  normalizeMoney,
  type PolygonCoords,
  requiresMfa,
  sortTemplates,
  toArea,
  validateArea,
  validateNewStaff,
  validateSlotTemplate,
  validateZoneFields,
  type ZoneFields,
} from './admin';

const square: PolygonCoords = [
  [
    [-78.5, -0.2],
    [-78.4, -0.2],
    [-78.4, -0.1],
    [-78.5, -0.1],
    [-78.5, -0.2],
  ],
];

describe('validateArea', () => {
  it('acepta un polígono cerrado con 4 vértices', () => {
    expect(validateArea({ type: 'Polygon', coordinates: square })).toEqual([]);
  });

  it('sin geometría pide dibujar', () => {
    expect(validateArea(null)).toEqual(['Dibuja el área de la zona en el mapa.']);
  });

  it('rechaza un anillo sin cerrar', () => {
    const open = [square[0].slice(0, 4)];
    expect(validateArea({ type: 'Polygon', coordinates: open }).join(' ')).toMatch(/no está cerrado/);
  });

  it('exige al menos 3 vértices distintos', () => {
    const line: PolygonCoords = [
      [
        [0, 0],
        [1, 1],
        [0, 0],
        [1, 1],
        [0, 0],
      ],
    ];
    expect(validateArea({ type: 'Polygon', coordinates: line }).join(' ')).toMatch(/3 vértices distintos/);
  });

  it('rechaza coordenadas fuera de rango (lat/lng invertidas)', () => {
    const swapped = [square[0].map(([lng, lat]) => [lat, lng])];
    expect(validateArea({ type: 'Polygon', coordinates: swapped })).toEqual([]);
    const bad = [square[0].map(([lng, lat]) => [lng * 3, lat])];
    expect(validateArea({ type: 'Polygon', coordinates: bad }).join(' ')).toMatch(/fuera de rango/);
  });

  it('respeta el máximo de vértices del backend', () => {
    const n = MAX_AREA_VERTICES; // + la posición que cierra = n + 1
    const ring = Array.from({ length: n }, (_, i) => [Math.cos((2 * Math.PI * i) / n), Math.sin((2 * Math.PI * i) / n)]);
    const geometry = { type: 'Polygon' as const, coordinates: [closeRing(ring)] };
    expect(countVertices(geometry)).toBe(n + 1);
    expect(validateArea(geometry).join(' ')).toMatch(/máximo es 2000/);
    const ok = { type: 'Polygon' as const, coordinates: [closeRing(ring.slice(0, n - 1))] };
    expect(validateArea(ok)).toEqual([]);
  });

  it('valida cada polígono de un MultiPolygon y nombra el que falla', () => {
    const errors = validateArea({ type: 'MultiPolygon', coordinates: [square, [square[0].slice(0, 4)]] });
    expect(errors).toEqual(['Polígono 2 no está cerrado.']);
  });
});

describe('toArea / closeRing / boundsOf', () => {
  it('uno → Polygon, varios → MultiPolygon, ninguno → null', () => {
    expect(toArea([])).toBeNull();
    expect(toArea([square])?.type).toBe('Polygon');
    expect(toArea([square, square])?.type).toBe('MultiPolygon');
  });

  it('closeRing agrega la primera posición solo si falta', () => {
    expect(closeRing([[0, 0], [1, 0], [1, 1]])).toEqual([[0, 0], [1, 0], [1, 1], [0, 0]]);
    expect(closeRing(square[0])).toBe(square[0]);
  });

  it('boundsOf encuadra todas las zonas', () => {
    expect(boundsOf([{ type: 'MultiPolygon', coordinates: [square] }])).toEqual([
      [-78.5, -0.2],
      [-78.4, -0.1],
    ]);
    expect(boundsOf([])).toBeNull();
  });
});

describe('zonas y franjas', () => {
  const fields: ZoneFields = {
    name: 'Quito Norte',
    city: 'Quito',
    deliveryMode: 'rider',
    priority: 100,
    baseFee: '2.50',
    feePerKm: '0.35',
    feePerExtraKg: '0',
    maxWeightKg: 15,
    freeShippingThreshold: null,
    sameDayCutoff: '14:00',
    servingWarehouseId: 'w1',
  };

  it('datos válidos', () => {
    expect(validateZoneFields(fields)).toBeNull();
  });

  it('motorizado propio exige bodega; courier no', () => {
    expect(validateZoneFields({ ...fields, servingWarehouseId: null })).toMatch(/bodega/);
    expect(validateZoneFields({ ...fields, deliveryMode: 'courier', servingWarehouseId: null })).toBeNull();
  });

  it('montos con 2 decimales y umbral > 0', () => {
    expect(validateZoneFields({ ...fields, baseFee: '2.505' })).toMatch(/Tarifa base/);
    expect(validateZoneFields({ ...fields, freeShippingThreshold: '0' })).toMatch(/umbral/);
    expect(normalizeMoney('2,5')).toBe('2.50');
  });

  it('plantilla: fin después de inicio y capacidad entera', () => {
    const t = { weekday: 1, startTime: '09:00', endTime: '12:00', capacity: 10, surcharge: '0' };
    expect(validateSlotTemplate(t)).toBeNull();
    expect(validateSlotTemplate({ ...t, endTime: '09:00' })).toMatch(/terminar después/);
    expect(validateSlotTemplate({ ...t, capacity: 1.5 })).toMatch(/capacidad/);
  });

  it('ordena las plantillas de lunes a domingo', () => {
    const sorted = sortTemplates([
      { weekday: 0, startTime: '09:00' },
      { weekday: 1, startTime: '15:00' },
      { weekday: 1, startTime: '09:00' },
    ]);
    expect(sorted.map((t) => `${t.weekday} ${t.startTime}`)).toEqual(['1 09:00', '1 15:00', '0 09:00']);
  });
});

describe('usuarios y roles', () => {
  const roles = [{ code: 'admin' }, { code: 'seller' }, { code: 'rider' }, { code: 'customer' }];

  it('solo ofrece roles del tipo de usuario', () => {
    expect(assignableRoles(roles, 'staff').map((r) => r.code)).toEqual(['admin', 'seller']);
    expect(assignableRoles(roles, 'rider').map((r) => r.code)).toEqual(['rider']);
  });

  it('alta de personal', () => {
    const ok = { email: 'ana@tienda.ec', firstName: 'Ana', lastName: 'Paz', roles: ['seller'] };
    expect(validateNewStaff(ok)).toBeNull();
    expect(validateNewStaff({ ...ok, roles: [] })).toMatch(/al menos un rol/);
    expect(validateNewStaff({ ...ok, roles: ['customer'] })).toMatch(/personal/);
    expect(validateNewStaff({ ...ok, phone: '12' })).toMatch(/teléfono/);
    expect(validateNewStaff({ ...ok, email: 'ana' })).toMatch(/email/);
  });

  it('admin requiere 2FA; bloqueo según estado', () => {
    expect(requiresMfa(['seller', 'admin'])).toBe(true);
    expect(requiresMfa(['seller'])).toBe(false);
    expect(blockAction('active')).toBe('block');
    expect(blockAction('blocked')).toBe('unblock');
    expect(blockAction('pending')).toBeNull();
  });

  it('bloqueo temporal por intentos', () => {
    const now = new Date('2026-10-07T12:00:00Z');
    expect(isTemporarilyLocked('2026-10-07T12:10:00Z', now)).toBe(true);
    expect(isTemporarilyLocked('2026-10-07T11:00:00Z', now)).toBe(false);
    expect(isTemporarilyLocked(null, now)).toBe(false);
  });

  it('agrupa permisos por módulo con nombre legible', () => {
    const groups = groupPermissions(['orders.read', 'iam.users.read', 'promotions.read', 'giftcards.read', 'orders.cancel']);
    expect(groups.map((g) => [g.label, g.permissions.length])).toEqual([
      ['Pedidos', 2],
      ['Usuarios y accesos', 1],
      ['Promociones', 2],
    ]);
  });
});
