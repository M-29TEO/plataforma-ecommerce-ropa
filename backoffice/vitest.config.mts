import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: {
    environment: 'jsdom',
    // Hilos en lugar de procesos: en OneDrive/Windows los forks tardan en arrancar y vencen el timeout.
    pool: 'threads',
    include: ['**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', '.next/**', 'e2e/**'],
    // Las fechas se prueban en la zona de la tienda aunque el equipo esté en otra.
    env: { TZ: 'UTC' },
  },
});
