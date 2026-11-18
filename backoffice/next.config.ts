import type { NextConfig } from 'next';

/**
 * Backoffice. En Docker va detrás de Caddy en el MISMO dominio que la tienda: /admin/* es esta app,
 * /api/* la API y /ws/* el realtime. Por eso basePath = '/admin' y las llamadas al API son relativas
 * (/api/v1/...): sin CORS y con la cookie httpOnly de refresh (Path=/api/v1/auth).
 *
 * En desarrollo (sin Caddy), `DEV_API_PROXY=http://localhost:3000` reescribe /api/* hacia la API.
 * `basePath: false` hace que la regla aplique fuera de /admin.
 */
const devApi = process.env.DEV_API_PROXY?.replace(/\/+$/, '');

const nextConfig: NextConfig = {
  basePath: '/admin',
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  async rewrites() {
    return devApi ? [{ source: '/api/:path*', destination: `${devApi}/:path*`, basePath: false }] : [];
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          // La cámara se usa en bodega (escaneo de códigos de barras); nada más.
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
          // Pantallas internas: nunca se indexan ni se guardan en cachés compartidas.
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Cache-Control', value: 'private, no-store' },
        ],
      },
    ];
  },
};

export default nextConfig;
