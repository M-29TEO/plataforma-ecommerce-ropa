/**
 * Menú según permisos. Cada pantalla declara qué permisos necesita y el menú, la página de inicio
 * y el guard de cada ruta se calculan con los permisos del JWT (claim `perms`).
 *
 * Esto es experiencia de uso, NO seguridad: la API vuelve a verificar cada permiso en cada llamada
 * (PermissionGuard). Un usuario que fuerce una URL ve un 403 del API, nunca datos.
 */

export interface Requirement {
  /** Exige TODOS estos permisos. */
  all?: readonly string[];
  /** Exige AL MENOS UNO de estos permisos. */
  any?: readonly string[];
}

export interface NavItem extends Requirement {
  href: string;
  label: string;
  /** Texto corto para la tarjeta de inicio. */
  description: string;
}

export interface NavSection {
  id: string;
  label: string;
  items: readonly NavItem[];
}

export function satisfies(perms: ReadonlySet<string> | readonly string[], req: Requirement): boolean {
  const set = perms instanceof Set ? perms : new Set(perms as readonly string[]);
  if (req.all && !req.all.every((p) => set.has(p))) return false;
  if (req.any && req.any.length > 0 && !req.any.some((p) => set.has(p))) return false;
  return true;
}

export const NAV: readonly NavSection[] = [
  {
    id: 'admin',
    label: 'Administración',
    items: [
      { href: '/catalogo/productos', label: 'Productos y variantes', description: 'Alta y edición de productos, tallas, colores y códigos de barras', all: ['catalog.product.write'] },
      { href: '/catalogo/precios', label: 'Precios', description: 'Precios base, por variante y precios tachados en lote', all: ['catalog.product.write'] },
      { href: '/usuarios', label: 'Usuarios', description: 'Personal y clientes: alta, bloqueo y contraseñas temporales', all: ['iam.users.read'] },
      { href: '/roles', label: 'Roles y permisos', description: 'Qué puede hacer cada rol y quién lo tiene', all: ['iam.roles.read'] },
      { href: '/zonas', label: 'Zonas de cobertura', description: 'Dibuja en el mapa las zonas de entrega y sus tarifas', all: ['logistics.zone.write'] },
    ],
  },
  {
    id: 'gerencia',
    label: 'Gerencia',
    items: [
      { href: '/gerencia', label: 'Dashboard de KPIs', description: 'Ventas, margen, conversión y entregas', any: ['reports.sales.read', 'reports.delivery.read', 'reports.funnel.read'] },
      { href: '/gerencia/exportes', label: 'Exportes', description: 'Reportes en Excel y PDF generados en segundo plano', all: ['reports.export'] },
    ],
  },
  {
    id: 'bodega',
    label: 'Bodega',
    items: [
      { href: '/bodega/picking', label: 'Picking', description: 'Prepara pedidos escaneando cada prenda con la cámara', all: ['inventory.picking'] },
      { href: '/bodega/recepciones', label: 'Recepción de compras', description: 'Recibe órdenes de compra de proveedores', all: ['inventory.purchase.receive'] },
      { href: '/bodega/ajustes', label: 'Ajustes de stock', description: 'Conteos, mermas y correcciones con motivo', all: ['inventory.adjust'] },
      { href: '/bodega/stock', label: 'Stock por bodega', description: 'Existencias, reservas y movimientos', all: ['inventory.read'] },
    ],
  },
  {
    id: 'ventas',
    label: 'Ventas',
    items: [
      { href: '/ventas/pedidos-asistidos', label: 'Pedidos asistidos', description: 'Arma pedidos a nombre de un cliente (teléfono, WhatsApp, tienda)', all: ['orders.assisted.create'] },
      { href: '/pedidos', label: 'Pedidos', description: 'Todos los pedidos con su estado e historial', all: ['orders.read'] },
      { href: '/devoluciones', label: 'Devoluciones', description: 'Devoluciones y cambios: aprobación, recepción, inspección y reembolso', all: ['returns.read'] },
    ],
  },
  {
    id: 'soporte',
    label: 'Soporte',
    items: [{ href: '/soporte/tickets', label: 'Tickets', description: 'Cola de tickets con SLA, respuestas y notas internas', all: ['support.tickets.read'] }],
  },
  {
    id: 'logistica',
    label: 'Logística',
    items: [
      { href: '/logistica/mapa', label: 'Mapa en vivo', description: 'Motorizados en tiempo real y envíos en curso', all: ['logistics.read'] },
      { href: '/logistica/despacho', label: 'Despacho', description: 'Asigna motorizados a los envíos listos', all: ['logistics.dispatch'] },
      { href: '/logistica/liquidaciones', label: 'Liquidaciones', description: 'Aprueba y paga las liquidaciones semanales de motorizados', any: ['logistics.settlement.approve', 'logistics.settlement.manage'] },
      { href: '/logistica/transferencias', label: 'Conciliación de transferencias', description: 'Verifica comprobantes contra el extracto bancario', all: ['payments.transfer.verify'] },
    ],
  },
];

/** Secciones con solo los ítems que el usuario puede ver (las vacías se omiten). */
export function visibleNav(perms: readonly string[]): NavSection[] {
  const set = new Set(perms);
  return NAV.map((s) => ({ ...s, items: s.items.filter((i) => satisfies(set, i)) })).filter((s) => s.items.length > 0);
}

/**
 * Ítem del menú que corresponde a una ruta (el más específico: /gerencia/exportes antes que
 * /gerencia). Las pantallas de detalle (/catalogo/productos/123) heredan el permiso de su lista.
 */
export function navItemFor(pathname: string): NavItem | null {
  let best: NavItem | null = null;
  for (const s of NAV) {
    for (const i of s.items) {
      if ((pathname === i.href || pathname.startsWith(`${i.href}/`)) && (!best || i.href.length > best.href.length)) best = i;
    }
  }
  return best;
}

/** ¿Puede ver esta ruta? Rutas fuera del menú (inicio, mi cuenta) son de cualquier staff con sesión. */
export function canAccess(pathname: string, perms: readonly string[]): boolean {
  const item = navItemFor(pathname);
  return item ? satisfies(new Set(perms), item) : true;
}
