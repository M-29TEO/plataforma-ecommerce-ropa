// ESLint de la app del motorizado (npm run lint = expo lint): reglas de Expo para React Native.
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  { ignores: ['dist/**', 'android/**', 'node_modules/**', '.expo/**'] },
]);
