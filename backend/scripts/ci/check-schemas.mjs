#!/usr/bin/env node
/**
 * Regla 2 de modularidad (docs/01-arquitectura-c4.md): un módulo solo lee y escribe SUS tablas de
 * PostgreSQL. dependency-cruiser no ve SQL, así que este script busca en el código de cada módulo las
 * referencias a tablas en contexto SQL (FROM, JOIN, INTO, UPDATE, ...) y falla si alguna es de otro dueño.
 *
 *   node scripts/ci/check-schemas.mjs        (npm run arch:schemas)
 *
 * Reportes queda exento: es el único módulo que lee entre schemas (vistas materializadas).
 * Límite conocido: solo detecta nombres calificados (schema.tabla), que es la convención del proyecto.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Dueños de las tablas. 'schema.*' = el schema entero es del módulo. Los schemas compartidos por
 * varios módulos (sales, platform) se reparten tabla por tabla.
 */
const OWNERS = {
  'shared-kernel': ['platform.outbox_events', 'platform.idempotency_keys', 'platform.audit_log', 'platform.processed_events'],
  iam: ['iam.*'],
  catalog: ['catalog.*'],
  inventory: ['inventory.*'],
  cart: ['sales.carts', 'sales.cart_items'],
  orders: ['sales.orders', 'sales.order_items', 'sales.order_status_history', 'sales.returns', 'sales.return_items'],
  promotions: [
    'sales.promotions',
    'sales.coupons',
    'sales.promotion_redemptions',
    'sales.gift_cards',
    'sales.gift_card_transactions',
  ],
  payments: ['payments.*'],
  logistics: ['logistics.*'],
  billing: ['billing.*'],
  crm: ['crm.*'],
  support: ['support.*'],
  notifications: ['platform.notifications', 'platform.notification_templates', 'platform.push_subscriptions'],
  // Orquestadores: componen casos de uso de otros módulos por su API pública, sin tablas propias.
  checkout: [],
  aftersales: [],
  fulfillment: [],
  storefront: [],
  privacy: [],
};
const EXEMPT = new Set(['reports']);

const SCHEMAS = ['platform', 'iam', 'catalog', 'inventory', 'sales', 'payments', 'logistics', 'billing', 'crm', 'support', 'reports', 'audit'];
const SQL_REF = new RegExp(
  String.raw`\b(?:from|join|into|update|table|references|truncate)\s+(?:only\s+)?"?(${SCHEMAS.join('|')})"?\."?([a-z_][a-z0-9_]*)"?`,
  'gi',
);

function* tsFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* tsFiles(path);
    else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) yield path;
  }
}

function owns(patterns, schema, table) {
  return patterns.some((p) => p === `${schema}.*` || p === `${schema}.${table}`);
}

const units = [
  ['shared-kernel', join(ROOT, 'libs', 'shared-kernel')],
  ...readdirSync(join(ROOT, 'libs', 'modules')).map((m) => [m, join(ROOT, 'libs', 'modules', m)]),
];

const violations = [];
let refs = 0;
for (const [unit, dir] of units) {
  if (EXEMPT.has(unit)) continue;
  const patterns = OWNERS[unit];
  if (!patterns) {
    violations.push(`${unit}: módulo nuevo sin dueño declarado en scripts/ci/check-schemas.mjs (OWNERS)`);
    continue;
  }
  for (const file of tsFiles(dir)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const [, schema, table] of line.matchAll(SQL_REF)) {
        refs++;
        const s = schema.toLowerCase();
        const t = table.toLowerCase();
        if (!owns(patterns, s, t)) {
          const owner = Object.entries(OWNERS).find(([, p]) => owns(p, s, t))?.[0] ?? 'sin dueño';
          violations.push(`${relative(ROOT, file).split(sep).join('/')}:${i + 1}  ${unit} usa ${s}.${t} (dueño: ${owner})`);
        }
      }
    });
  }
}

if (violations.length) {
  console.error(`✗ ${violations.length} acceso(s) a tablas de otro módulo (regla 2, docs/01-arquitectura-c4.md):`);
  for (const v of violations) console.error(`  ${v}`);
  console.error('Usa la API pública del módulo dueño (index.ts) o un evento; Reportes es el único exento.');
  process.exit(1);
}
console.log(`✔ cada módulo usa solo sus tablas (${refs} referencias SQL revisadas en ${units.length} unidades)`);
