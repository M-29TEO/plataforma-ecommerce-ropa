import { createHmac } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';

/**
 * Backoffice de punta a punta contra la API real con los usuarios de `npm run seed:dev`
 * (backend/scripts/seed-iam.ts): login en dos pasos del admin, menú según el rol, 403 por URL,
 * rechazo de cuentas de cliente y pantallas principales de cada área cargando datos del API.
 */
const PASSWORD = process.env.E2E_PASSWORD || 'Demo-2026-segura';
/** Secreto TOTP fijo del admin de desarrollo (seed-iam.ts). SOLO desarrollo. */
const ADMIN_TOTP_SECRET = process.env.E2E_ADMIN_TOTP || 'NVXWIYJNMRSW23ZNMFSG22LOFUZGMYJB';

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of input.replace(/=+$/, '').toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Código TOTP (RFC 6238, SHA-1, 6 dígitos, 30 s) para el paso indicado. */
function totp(secret: string, step = Math.floor(Date.now() / 30_000)): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0x0f;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function loginWithPassword(page: Page, email: string) {
  await page.goto('/admin/ingresar');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Contraseña').fill(PASSWORD);
  await page.getByRole('button', { name: 'Ingresar' }).click();
}

async function loginAs(page: Page, email: string) {
  await loginWithPassword(page, email);
  await expect(page.getByRole('heading', { level: 1, name: /^Hola/ })).toBeVisible();
}

/**
 * Avisos de error de la pantalla. El anunciador de rutas de Next también es role=alert (lee el
 * título tras navegar), así que se excluye por su id.
 */
const errors = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)').filter({ hasText: /\S/ });

const menu = (page: Page) => page.getByRole('navigation', { name: 'Menú principal' });

test.describe.configure({ mode: 'serial' });

test('admin: contraseña + código 2FA, menú completo y pantallas de administración', async ({ page }) => {
  await loginWithPassword(page, 'admin@demo.test');
  // El admin siempre pasa por el segundo factor.
  await expect(page.getByLabel('Código de verificación')).toBeVisible();
  // El anti-replay del API acepta cada paso de 30 s una sola vez: se usa el siguiente si este ya se gastó.
  await page.getByLabel('Código de verificación').fill(totp(ADMIN_TOTP_SECRET));
  await page.getByRole('button', { name: 'Verificar' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /^Hola/ })).toBeVisible();

  for (const label of ['Productos y variantes', 'Usuarios', 'Zonas de cobertura', 'Dashboard de KPIs', 'Picking', 'Pedidos asistidos', 'Tickets', 'Mapa en vivo', 'Conciliación de transferencias']) {
    await expect(menu(page).getByRole('link', { name: label })).toBeVisible();
  }

  await menu(page).getByRole('link', { name: 'Usuarios' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Usuarios' })).toBeVisible();
  await expect(page.getByText('bodega@demo.test')).toBeVisible();

  await menu(page).getByRole('link', { name: 'Roles y permisos' }).click();
  await expect(page.getByText('Logística').first()).toBeVisible();

  await menu(page).getByRole('link', { name: 'Productos y variantes' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Productos' })).toBeVisible();
  await expect(page.locator('table tbody tr').first()).toBeVisible();
});

test('bodega: sin 2FA, menú de bodega, 403 en usuarios y cola de picking', async ({ page }) => {
  await loginAs(page, 'bodega@demo.test');
  await expect(menu(page).getByRole('link', { name: 'Picking' })).toBeVisible();
  await expect(menu(page).getByRole('link', { name: 'Recepción de compras' })).toBeVisible();
  await expect(menu(page).getByRole('link', { name: 'Usuarios' })).toHaveCount(0);
  await expect(menu(page).getByRole('link', { name: 'Precios' })).toHaveCount(0);

  // Forzar la URL no muestra datos: aviso 403 sin llamar al API.
  await page.goto('/admin/usuarios');
  await expect(page.getByRole('heading', { name: 'Tu rol no tiene acceso a esta pantalla' })).toBeVisible();

  await page.goto('/admin/bodega/picking');
  await expect(page.getByRole('heading', { level: 1, name: 'Picking' })).toBeVisible();
  await expect(errors(page)).toHaveCount(0);
});

test('vendedor: pedidos asistidos y búsqueda de clientes', async ({ page }) => {
  await loginAs(page, 'vendedor@demo.test');
  await expect(menu(page).getByRole('link', { name: 'Pedidos asistidos' })).toBeVisible();
  await expect(menu(page).getByRole('link', { name: 'Picking' })).toHaveCount(0);
  await menu(page).getByRole('link', { name: 'Pedidos asistidos' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Pedidos asistidos' })).toBeVisible();
  await page.getByRole('link', { name: /Nuevo pedido asistido/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Nuevo pedido asistido' })).toBeVisible();
});

test('gerente: dashboard de KPIs sin errores', async ({ page }) => {
  await loginAs(page, 'gerente@demo.test');
  await menu(page).getByRole('link', { name: 'Dashboard de KPIs' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard de KPIs' })).toBeVisible();
  await expect(errors(page)).toHaveCount(0);
});

test('soporte: cola de tickets', async ({ page }) => {
  await loginAs(page, 'soporte@demo.test');
  await expect(menu(page).getByRole('link', { name: 'Tickets' })).toBeVisible();
  await expect(menu(page).getByRole('link', { name: 'Usuarios' })).toHaveCount(0);
  await menu(page).getByRole('link', { name: 'Tickets' }).click();
  await expect(errors(page)).toHaveCount(0);
});

test('logística: mapa en vivo conectado por Socket.IO y conciliación', async ({ page }) => {
  await loginAs(page, 'logistica@demo.test');
  await menu(page).getByRole('link', { name: 'Mapa en vivo' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Mapa en vivo' })).toBeVisible();
  await expect(page.getByText('En vivo', { exact: true })).toBeVisible();
  await menu(page).getByRole('link', { name: 'Conciliación de transferencias' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Conciliación de transferencias' })).toBeVisible();
});

test('una cuenta de cliente no entra al backoffice', async ({ page }) => {
  await loginWithPassword(page, 'cliente@demo.test');
  await expect(errors(page)).toContainText('no tiene acceso al backoffice');
  // Y no queda sesión: volver al panel pide ingresar de nuevo.
  await page.goto('/admin/');
  await expect(page).toHaveURL(/\/admin\/ingresar/);
});
