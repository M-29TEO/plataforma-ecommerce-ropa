import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

/** Punto dentro de la zona Quito Norte del seed (CCI, Av. Amazonas y Naciones Unidas). */
const QUITO_NORTE = { latitude: -0.1765, longitude: -78.48 };
/** El host lee este archivo y lanza el simulador del motorizado para ese pedido (npm run sim:rider). */
const ORDER_FILE = process.env.E2E_ORDER_FILE;

test.describe('Storefront', () => {
  test('catálogo: filtros en la URL, ficha con guía de tallas y búsqueda', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Novedades' })).toBeVisible();

    await page.goto('/categoria/mujer');
    await expect(page.getByRole('heading', { level: 1, name: 'Mujer' })).toBeVisible();
    const before = await page.getByRole('region', { name: 'Productos' }).getByRole('article').count();
    await page.getByRole('button', { name: /^XS/ }).click();
    await expect(page).toHaveURL(/talla=XS/);
    await expect(page.getByRole('button', { name: /^XS/ })).toHaveAttribute('aria-pressed', 'true');
    // Con filtros la página no se indexa y apunta a la canónica.
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    const after = await page.getByRole('region', { name: 'Productos' }).getByRole('article').count();
    expect(after).toBeLessThanOrEqual(before);

    await page.goto('/producto/vestido-midi-lino');
    await expect(page.getByRole('heading', { level: 1, name: 'Vestido midi de lino' })).toBeVisible();
    const jsonLd = await page.locator('script[type="application/ld+json"]').allTextContents();
    expect(jsonLd.some((j) => j.includes('"@type":"Product"'))).toBe(true);
    await page.getByRole('button', { name: 'Guía de tallas' }).click();
    await expect(page.getByRole('dialog', { name: /partes de arriba/ })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Busto' })).toBeVisible();
    await page.getByRole('button', { name: 'Cerrar guía de tallas' }).click();

    await page.goto('/buscar?q=lino');
    await expect(page.getByRole('heading', { name: /Resultados para «lino»/ })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Productos' }).getByRole('article').first()).toBeVisible();
  });

  test('compra como invitado con mapa, franja y pasarela; tracking en vivo hasta la entrega', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ geolocation: QUITO_NORTE });
    await context.grantPermissions(['geolocation'], { origin: baseURL });
    const page = await context.newPage();

    // Agregar al carrito: color y talla con stock.
    await page.goto('/producto/camiseta-basica-organica');
    const sizes = page.getByRole('radiogroup', { name: 'Talla' }).getByRole('radio');
    const count = await sizes.count();
    for (let i = 0; i < count; i++) {
      if (await sizes.nth(i).isEnabled()) {
        await sizes.nth(i).click();
        break;
      }
    }
    await page.getByRole('button', { name: 'Agregar al carrito' }).click();
    const drawer = page.getByRole('dialog', { name: 'Tu carrito' });
    await expect(drawer.getByText('Camiseta básica orgánica')).toBeVisible();
    await drawer.getByRole('link', { name: 'Pagar' }).click();

    // Checkout como invitado.
    await expect(page.getByRole('heading', { name: 'Finalizar compra' })).toBeVisible();
    await expect(page.getByText('Compras como invitado.')).toBeVisible();
    await page.getByLabel('Nombre y apellido').fill('Paula Andrade');
    await page.getByLabel('Celular').fill('0987654321');
    await page.getByLabel(/^Correo/).fill('paula.e2e@example.test');
    await page.getByLabel('Calle principal').fill('Av. Amazonas');
    await page.getByLabel('Calle secundaria').fill('Naciones Unidas');
    await page.getByLabel('Referencia').fill('Junto al centro comercial');
    // Pin en el mapa con el GPS del navegador.
    await page.getByRole('button', { name: /Usar mi ubicación/ }).click();
    await expect(page.getByText('Ajusta el pin exactamente en tu puerta')).toBeVisible();

    // Opciones de envío con franja horaria.
    await expect(page.getByText(/Motorizado/).first()).toBeVisible({ timeout: 30_000 });
    const slots = page.locator('input[name="slot"]');
    if ((await slots.count()) > 0) await expect(page.locator('input[name="slot"]:checked')).toHaveCount(1);

    await page.getByRole('radio', { name: /Tarjeta de crédito o débito/ }).check();
    await page.getByRole('button', { name: /^Pagar \$/ }).click();

    // Pasarela simulada: aprobar y volver a la tienda.
    await page.waitForURL(/:8081\/pay/, { timeout: 30_000 });
    await page.getByRole('button', { name: 'Aprobar pago' }).click();
    await page.getByRole('link', { name: 'Volver a la tienda' }).click();
    await page.waitForURL(/\/checkout\/resultado\?paymentId=/);
    await expect(page.getByRole('heading', { name: '¡Pago confirmado!' })).toBeVisible({ timeout: 60_000 });
    const text = (await page.getByText(/Pedido #\d+/).first().textContent()) ?? '';
    const orderNumber = /Pedido #(\d+)/.exec(text)?.[1];
    expect(orderNumber).toBeTruthy();

    // Seguimiento en vivo: el host simula al motorizado cuando encuentra el número de pedido.
    await page.getByRole('link', { name: 'Seguir mi pedido' }).click();
    await page.waitForURL(/\/seguimiento\//);
    await expect(page.getByText('En vivo')).toBeVisible({ timeout: 30_000 });
    if (ORDER_FILE) writeFileSync(ORDER_FILE, orderNumber!);
    await expect(page.getByRole('heading', { name: /en camino|llegando/i })).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText(/Llega en/)).toBeVisible();
    // El marcador del motorizado está en el mapa.
    await expect(page.locator('.maplibregl-marker', { hasText: '🛵' })).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Tu pedido fue entregado' })).toBeVisible({ timeout: 120_000 });
    await expect(page.locator('.maplibregl-marker', { hasText: '🛵' })).toHaveCount(0);
    console.log(`Pedido ${orderNumber} entregado en ${baseURL}`);
    await context.close();
  });

  test('cliente registrado: ingresar, favoritos y mis pedidos @movil', async ({ page }, info) => {
    // Escritorio y móvil corren en paralelo con la misma cuenta: cada uno marca un producto distinto.
    const product = info.project.name === 'movil' ? { slug: 'jean-wide-leg', name: 'Jean wide leg' } : { slug: 'jean-mom-tiro-alto', name: 'Jean mom de tiro alto' };
    await page.goto('/ingresar?volver=/mi-cuenta');
    await page.getByLabel('Correo').fill('cliente@demo.test');
    await page.getByLabel('Contraseña').fill('Demo-2026-segura');
    await page.getByRole('button', { name: 'Ingresar' }).click();
    await page.waitForURL(/\/mi-cuenta$/);
    await expect(page.getByRole('heading', { name: 'Mi cuenta' })).toBeVisible();

    await page.goto(`/producto/${product.slug}`);
    await page.getByRole('button', { name: 'Guardar en favoritos' }).first().click();
    await expect(page.getByRole('button', { name: 'Quitar de favoritos' }).first()).toBeVisible();
    await page.goto('/mi-cuenta/favoritos');
    await expect(page.getByText(product.name)).toBeVisible();

    await page.goto('/mi-cuenta/pedidos');
    await expect(page.getByRole('heading', { name: 'Mis pedidos' })).toBeVisible();
    await expect(page.getByText(/Pedido #\d+/).first()).toBeVisible();
  });
});
