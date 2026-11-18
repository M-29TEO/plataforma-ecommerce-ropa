import { defineConfig, devices } from '@playwright/test';

/**
 * Pruebas de punta a punta contra un storefront ya levantado (E2E_BASE_URL) con su API, realtime y
 * pasarela simulada. Se corren en el contenedor oficial de Playwright (no instala navegadores en
 * el equipo): ver "Pruebas e2e" en storefront/README.md.
 */
const baseURL = process.env.E2E_BASE_URL || 'http://localhost:3100';

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL,
    locale: 'es-EC',
    timezoneId: 'America/Guayaquil',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Origen http que no es localhost: se trata como seguro para el service worker y la geolocalización.
    launchOptions: { args: [`--unsafely-treat-insecure-origin-as-secure=${baseURL}`] },
  },
  projects: [
    { name: 'escritorio', use: { ...devices['Desktop Chrome'] } },
    { name: 'movil', use: { ...devices['Pixel 7'] }, grep: /@movil/ },
  ],
});
