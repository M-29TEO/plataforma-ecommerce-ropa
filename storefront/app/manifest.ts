import type { MetadataRoute } from 'next';
import { STORE_NAME } from '@/lib/config';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: STORE_NAME,
    short_name: STORE_NAME,
    description: 'Moda hecha en Ecuador: compra, paga y sigue tu pedido en vivo.',
    lang: 'es-EC',
    start_url: '/?origen=pwa',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#fbf8f4',
    theme_color: '#1f1b16',
    categories: ['shopping', 'lifestyle'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Mis pedidos', url: '/mi-cuenta/pedidos' },
      { name: 'Ofertas', url: '/ofertas' },
    ],
  };
}
