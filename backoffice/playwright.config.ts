import { defineConfig, devices } from '@playwright/test';

/**
 * Pruebas de punta a punta contra un backoffice ya levantado (E2E_BASE_URL) con su API y realtime,
 * sembrados con `npm run seed:dev`. Se corren en el contenedor oficial de Playwright (no instala
 * navegadores en el equipo): ver "Pruebas e2e" en backoffice/README.md.
 */
const baseURL = process.env.E2E_BASE_URL || 'http://localhost:3200';

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL,
    locale: 'es-EC',
    timezoneId: 'America/Guayaquil',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'escritorio', use: { ...devices['Desktop Chrome'] } }],
});
