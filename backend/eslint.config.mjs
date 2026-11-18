// ESLint del backend (flat config). Las reglas de arquitectura (quién importa a quién) no van aquí:
// las revisa dependency-cruiser (npm run arch:check, ver .dependency-cruiser.cjs).
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'security-reports/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // Variables y argumentos sin usar: se permiten con prefijo _ (firmas de ports, destructuring).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      // NestJS usa clases vacías como módulos y DTOs; las interfaces vacías marcan contratos de ports.
      '@typescript-eslint/no-extraneous-class': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // Los scripts de consola (seeds, generadores) imprimen resultados a propósito.
    files: ['scripts/**/*.ts', 'apps/**/main.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.spec.ts', 'test/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.jest } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
