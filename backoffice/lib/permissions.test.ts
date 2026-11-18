import { describe, expect, it } from 'vitest';
import { canAccess, NAV, navItemFor, satisfies, visibleNav } from './permissions';

/** Permisos de los roles del sistema (backend/libs/modules/iam/domain/system-roles.ts), abreviados a lo que usa el menú. */
const ROLE_PERMS: Record<string, string[]> = {
  manager: ['inventory.read', 'orders.read', 'logistics.read', 'logistics.settlement.approve', 'catalog.product.write', 'reports.sales.read', 'reports.delivery.read', 'reports.funnel.read', 'reports.export', 'iam.roles.read', 'iam.users.read', 'support.tickets.read', 'returns.read', 'returns.approve', 'payments.refund.approve'],
  seller: ['catalog.product.write', 'inventory.read', 'orders.read', 'orders.assisted.create'],
  warehouse: ['inventory.read', 'inventory.adjust', 'inventory.purchase.receive', 'inventory.picking', 'orders.read', 'returns.read', 'returns.inspect', 'logistics.read', 'logistics.dispatch'],
  support: ['support.tickets.read', 'support.tickets.write', 'orders.read', 'returns.read', 'returns.approve'],
  logistics: ['logistics.read', 'logistics.zone.write', 'logistics.dispatch', 'logistics.settlement.manage', 'logistics.settlement.approve', 'orders.read', 'payments.read', 'payments.transfer.verify'],
};
const ALL = [...new Set(NAV.flatMap((s) => s.items.flatMap((i) => [...(i.all ?? []), ...(i.any ?? [])])))];

const hrefs = (perms: string[]) => visibleNav(perms).flatMap((s) => s.items.map((i) => i.href));

describe('menú según permisos', () => {
  it('satisfies: all exige todos, any exige alguno', () => {
    expect(satisfies(['a', 'b'], { all: ['a', 'b'] })).toBe(true);
    expect(satisfies(['a'], { all: ['a', 'b'] })).toBe(false);
    expect(satisfies(['b'], { any: ['a', 'b'] })).toBe(true);
    expect(satisfies([], { any: ['a'] })).toBe(false);
    expect(satisfies([], {})).toBe(true);
  });

  it('el admin (todos los permisos) ve todas las pantallas', () => {
    expect(hrefs(ALL)).toEqual(NAV.flatMap((s) => s.items.map((i) => i.href)));
  });

  it('sin permisos no hay secciones (un staff sin rol solo ve Inicio)', () => {
    expect(visibleNav([])).toEqual([]);
  });

  it('bodega ve picking, recepciones, ajustes, stock y despacho; no precios ni usuarios', () => {
    const h = hrefs(ROLE_PERMS.warehouse);
    expect(h).toEqual(expect.arrayContaining(['/bodega/picking', '/bodega/recepciones', '/bodega/ajustes', '/bodega/stock', '/logistica/despacho']));
    expect(h).not.toContain('/catalogo/precios');
    expect(h).not.toContain('/usuarios');
  });

  it('vendedor ve pedidos asistidos y consulta stock; no prepara pedidos ni ve logística', () => {
    const h = hrefs(ROLE_PERMS.seller);
    expect(h).toEqual(expect.arrayContaining(['/ventas/pedidos-asistidos', '/bodega/stock']));
    expect(h).not.toContain('/bodega/picking');
    expect(h.some((x) => x.startsWith('/logistica'))).toBe(false);
  });

  it('gerente ve el dashboard, exportes y liquidaciones (por permiso any)', () => {
    const h = hrefs(ROLE_PERMS.manager);
    expect(h).toEqual(expect.arrayContaining(['/gerencia', '/gerencia/exportes', '/logistica/liquidaciones']));
    expect(h).not.toContain('/logistica/transferencias');
  });

  it('soporte solo ve tickets, pedidos y devoluciones', () => {
    expect(hrefs(ROLE_PERMS.support)).toEqual(['/pedidos', '/devoluciones', '/soporte/tickets']);
  });

  it('devoluciones: soporte, gerente y bodega (para recibir e inspeccionar); no el vendedor', () => {
    for (const role of ['support', 'manager', 'warehouse']) expect(hrefs(ROLE_PERMS[role])).toContain('/devoluciones');
    expect(hrefs(ROLE_PERMS.seller)).not.toContain('/devoluciones');
    expect(navItemFor('/devoluciones/123')?.href).toBe('/devoluciones');
  });

  it('logística ve el mapa, despacho, liquidaciones y conciliación', () => {
    expect(hrefs(ROLE_PERMS.logistics)).toEqual(
      expect.arrayContaining(['/logistica/mapa', '/logistica/despacho', '/logistica/liquidaciones', '/logistica/transferencias', '/zonas']),
    );
  });
});

describe('acceso por ruta', () => {
  it('el detalle hereda el permiso de su lista y gana la ruta más específica', () => {
    expect(navItemFor('/catalogo/productos/123')?.href).toBe('/catalogo/productos');
    expect(navItemFor('/gerencia/exportes')?.href).toBe('/gerencia/exportes');
    expect(navItemFor('/gerencia')?.href).toBe('/gerencia');
    expect(navItemFor('/gerenciax')).toBeNull();
  });

  it('bloquea rutas sin permiso y deja pasar las que no son del menú', () => {
    expect(canAccess('/usuarios', ROLE_PERMS.seller)).toBe(false);
    expect(canAccess('/ventas/pedidos-asistidos/nuevo', ROLE_PERMS.seller)).toBe(true);
    expect(canAccess('/cuenta', [])).toBe(true);
    expect(canAccess('/', [])).toBe(true);
  });
});
