/**
 * Reglas de modularidad del monolito (docs/01-arquitectura-c4.md, "Reglas de modularidad").
 * Se revisan en CI con:  npm run arch:check
 *
 * La regla 2 (cada módulo solo usa su propio schema de PostgreSQL) no es un import: la revisa
 * scripts/ci/check-schemas.mjs (npm run arch:schemas).
 */
const PROD = '^(apps|libs)/';
const TESTS = '(\\.spec\\.ts$|^test/)';

module.exports = {
  forbidden: [
    {
      name: 'solo-index-de-otro-modulo',
      comment:
        'Regla 1: un módulo solo importa el index.ts (API pública) de otro módulo, nunca sus internos. ' +
        'Excepción: events.ts, los contratos de eventos (sin Nest ni base), para suscribirse sin ciclos.',
      severity: 'error',
      from: { path: '^libs/modules/([^/]+)/', pathNot: TESTS },
      to: {
        path: '^libs/modules/[^/]+/',
        pathNot: ['^libs/modules/$1/', '^libs/modules/[^/]+/(index|events)\\.ts$'],
      },
    },
    {
      name: 'apps-solo-por-index',
      comment: 'Los bootstraps (api, worker, realtime) usan los módulos por su API pública.',
      severity: 'error',
      from: { path: '^apps/' },
      to: { path: '^libs/modules/[^/]+/', pathNot: '^libs/modules/[^/]+/index\\.ts$' },
    },
    {
      name: 'sin-ciclos-entre-modulos',
      comment:
        'Dos módulos que se importan entre sí (directa o indirectamente) dejan de ser separables. ' +
        'Los flujos que cruzan módulos van por orquestadores (checkout, aftersales, fulfillment) o por eventos.',
      severity: 'error',
      from: { path: '^libs/modules/([^/]+)/', pathNot: TESTS },
      to: { circular: true, path: '^libs/modules/', pathNot: '^libs/modules/$1/' },
    },
    {
      name: 'shared-kernel-no-depende-de-modulos',
      comment: 'El shared kernel es la base de todos: no puede conocer ningún módulo ni app.',
      severity: 'error',
      from: { path: '^libs/shared-kernel/', pathNot: TESTS },
      to: { path: '^(libs/modules|apps)/' },
    },
    {
      name: 'libs-no-dependen-de-apps',
      severity: 'error',
      from: { path: '^libs/' },
      to: { path: '^apps/' },
    },
    {
      name: 'dominio-puro',
      comment: 'Hexagonal: el dominio no depende de las capas de aplicación, api ni infraestructura.',
      severity: 'error',
      from: { path: '^libs/modules/([^/]+)/domain/', pathNot: TESTS },
      to: { path: '^libs/modules/$1/(application|api|infrastructure)/' },
    },
    {
      name: 'aplicacion-sin-infraestructura',
      comment:
        'Hexagonal: los casos de uso dependen de ports (interfaces), no de adaptadores concretos ni de controllers.',
      severity: 'error',
      from: { path: '^libs/modules/([^/]+)/application/', pathNot: TESTS },
      to: { path: '^libs/modules/$1/(api|infrastructure)/' },
    },
    {
      name: 'produccion-sin-dev-dependencies',
      comment: 'El código que va a la imagen no puede importar devDependencies (se borran con npm prune).',
      severity: 'error',
      from: { path: PROD, pathNot: TESTS },
      to: { dependencyTypes: ['npm-dev'], dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'sin-imports-rotos',
      severity: 'error',
      from: {},
      // class-transformer/types/storage: solo un tipo (import type en un script de seguridad).
      to: { couldNotResolve: true, pathNot: '^class-transformer/types/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '^(dist|security-reports|coverage)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.js', '.json'],
    },
    reporterOptions: {
      dot: { collapsePattern: '^(libs/modules/[^/]+|libs/shared-kernel|apps/[^/]+)/' },
    },
  },
};
