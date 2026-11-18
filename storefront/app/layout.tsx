import type { Metadata, Viewport } from 'next';
import { CartDrawer } from '@/components/cart/CartDrawer';
import { Footer } from '@/components/layout/Footer';
import { Header } from '@/components/layout/Header';
import { Providers } from '@/components/providers/Providers';
import { SITE_URL, STORE_NAME } from '@/lib/config';
import './globals.css';

/** Las páginas estáticas (envíos, guía de tallas) se regeneran cada 5 min: así el menú de categorías se actualiza. */
export const revalidate = 300;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: `${STORE_NAME} · Moda hecha en Ecuador`, template: `%s | ${STORE_NAME}` },
  description: 'Ropa para mujer, hombre y unisex con envío a domicilio en Quito y todo Ecuador. Paga en línea o contra entrega y sigue tu pedido en vivo.',
  applicationName: STORE_NAME,
  appleWebApp: { capable: true, title: STORE_NAME, statusBarStyle: 'default' },
  icons: { apple: '/icons/apple-touch-icon.png' },
  openGraph: { type: 'website', locale: 'es_EC', siteName: STORE_NAME },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: '#1f1b16',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-EC">
      <body className="flex min-h-dvh flex-col">
        <Providers>
          <a href="#contenido" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2">
            Saltar al contenido
          </a>
          <Header />
          <main id="contenido" className="flex-1">
            {children}
          </main>
          <Footer />
          <CartDrawer />
        </Providers>
      </body>
    </html>
  );
}
