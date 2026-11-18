/**
 * Tests de integración contra PostgreSQL + PostGIS y Valkey reales (Testcontainers).
 * La concurrencia y los bloqueos no se pueden probar con mocks.
 */
module.exports = {
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.int-spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  globalSetup: '<rootDir>/test/global-setup.mjs',
  globalTeardown: '<rootDir>/test/global-teardown.mjs',
  testTimeout: 60_000,
  // Cada archivo levanta su propia app con un pool de conexiones: se limita el paralelismo
  // para no superar max_connections de PostgreSQL.
  maxWorkers: 2,
};
