import { UserType } from './user-account';

/**
 * Catálogo de permisos (iam.permissions, sembrado por las migraciones de cada módulo). Un test
 * de integración verifica que esta lista y la tabla coincidan.
 */
export const PERMISSIONS = {
  inventory: [
    'inventory.read',
    'inventory.warehouse.write',
    'inventory.stock.write',
    'inventory.adjust',
    'inventory.supplier.write',
    'inventory.purchase.write',
    'inventory.purchase.receive',
    'inventory.picking',
  ],
  orders: ['orders.read', 'orders.status.update', 'orders.cancel', 'orders.payment.confirm', 'orders.assisted.create'],
  promotions: ['promotions.read', 'promotions.write', 'giftcards.read', 'giftcards.write'],
  payments: ['payments.read', 'payments.transfer.verify', 'payments.refund.approve', 'payments.refund.complete'],
  logistics: ['logistics.read', 'logistics.zone.write', 'logistics.dispatch', 'logistics.settlement.manage', 'logistics.settlement.approve'],
  billing: ['billing.read'],
  returns: ['returns.read', 'returns.approve', 'returns.inspect'],
  notifications: ['notifications.read', 'notifications.templates.write'],
  crm: ['crm.read', 'crm.loyalty.adjust', 'crm.tiers.write'],
  catalog: ['catalog.product.write', 'catalog.reviews.moderate', 'catalog.questions.answer'],
  support: ['support.tickets.read', 'support.tickets.write', 'support.tickets.assign'],
  reports: ['reports.sales.read', 'reports.delivery.read', 'reports.funnel.read', 'reports.export'],
  iam: ['iam.roles.read', 'iam.roles.assign', 'iam.mfa.reset', 'iam.users.read', 'iam.users.write'],
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS][number];
export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS).flat();

export const SYSTEM_ROLE_CODES = ['admin', 'manager', 'seller', 'warehouse', 'rider', 'support', 'customer', 'logistics'] as const;
export type SystemRoleCode = (typeof SYSTEM_ROLE_CODES)[number];

export interface SystemRole {
  code: SystemRoleCode;
  name: string;
  /** Tipo de usuario (iam.users.user_type) al que se puede asignar. */
  userType: UserType;
  permissions: readonly Permission[];
}

/**
 * Los 7 roles del enunciado, como datos: IAM los sincroniza en iam.roles (is_system = true) y
 * iam.role_permissions de cada tenant. Cambiar un permiso aquí lo cambia en todos los tenants al
 * siguiente arranque. Motorizado y cliente no tienen permisos de backoffice: sus rutas
 * (/rider/..., /me/...) se autorizan por el tipo de usuario del token.
 */
export const SYSTEM_ROLES: readonly SystemRole[] = [
  { code: 'admin', name: 'Administrador', userType: 'staff', permissions: ALL_PERMISSIONS },
  {
    code: 'manager',
    name: 'Gerente',
    userType: 'staff',
    permissions: [
      'inventory.read',
      'orders.read',
      'orders.cancel',
      ...PERMISSIONS.promotions,
      'payments.read',
      'payments.refund.approve',
      'logistics.read',
      'logistics.settlement.approve',
      'billing.read',
      'returns.read',
      'returns.approve',
      'notifications.read',
      ...PERMISSIONS.crm,
      ...PERMISSIONS.catalog,
      'support.tickets.read',
      ...PERMISSIONS.reports,
      'iam.roles.read',
      'iam.users.read',
    ],
  },
  {
    code: 'seller',
    name: 'Vendedor',
    userType: 'staff',
    permissions: [...PERMISSIONS.catalog, 'inventory.read', 'orders.read', 'orders.assisted.create', 'promotions.read', 'giftcards.read', 'crm.read'],
  },
  {
    code: 'warehouse',
    name: 'Bodega',
    userType: 'staff',
    permissions: [...PERMISSIONS.inventory, 'orders.read', 'orders.status.update', 'returns.read', 'returns.inspect', 'logistics.read', 'logistics.dispatch'],
  },
  { code: 'rider', name: 'Motorizado', userType: 'rider', permissions: [] },
  {
    code: 'support',
    name: 'Soporte',
    userType: 'staff',
    permissions: [
      ...PERMISSIONS.support,
      'orders.read',
      'returns.read',
      'returns.approve',
      'payments.read',
      'billing.read',
      'crm.read',
      'giftcards.read',
      'notifications.read',
      'catalog.questions.answer',
    ],
  },
  { code: 'customer', name: 'Cliente', userType: 'customer', permissions: [] },
  /**
   * Coordinador de logística (agregado con el backoffice, 2026-10-07): el enunciado no lo nombra,
   * pero el mapa en vivo, el despacho, las liquidaciones de motorizados y la conciliación de
   * transferencias son un puesto propio; sin él, solo el admin podría hacerlo todo.
   */
  {
    code: 'logistics',
    name: 'Logística',
    userType: 'staff',
    permissions: [
      ...PERMISSIONS.logistics,
      'inventory.read',
      'orders.read',
      'payments.read',
      'payments.transfer.verify',
      'reports.delivery.read',
    ],
  },
];

export function findSystemRole(code: string): SystemRole | undefined {
  return SYSTEM_ROLES.find((r) => r.code === code);
}

/** Un rol solo se asigna a su tipo de usuario: no hay clientes "admin" ni motorizados "bodega". */
export function canHoldRole(userType: UserType, role: Pick<SystemRole, 'userType'>): boolean {
  return role.userType === userType;
}
