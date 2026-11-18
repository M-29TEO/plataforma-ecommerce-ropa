// Copia el worker de MapLibre a public/. MapLibre 6 lo busca junto a su propio módulo
// (import.meta.url), que el bundler de Next reescribe: el worker terminaba pidiendo la URL de la
// página y el mapa quedaba en blanco. components/map/useMap.ts le indica esta copia con setWorkerUrl.
// Se ejecuta en predev/prebuild y en el Dockerfile (que llama a `next build` directamente).
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = createRequire(join(root, 'package.json')).resolve('maplibre-gl/package.json');
mkdirSync(join(root, 'public'), { recursive: true });
copyFileSync(join(dirname(pkg), 'dist', 'maplibre-gl-worker.mjs'), join(root, 'public', 'maplibre-gl-worker.mjs'));
console.log('public/maplibre-gl-worker.mjs listo');
