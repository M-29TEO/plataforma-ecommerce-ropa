import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const config = [
  ...nextVitals,
  ...nextTs,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      // Cargar datos al montar (fetch → setState) es el patrón de las páginas de cliente (cuenta,
      // checkout, tracking); las que importan para SEO se renderizan en el servidor. Se avisa, no se bloquea.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
  { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts', 'e2e-out/**'] },
];

export default config;
