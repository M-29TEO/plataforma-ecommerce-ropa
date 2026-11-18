import type { Metadata, Viewport } from 'next';
import { Providers } from '@/components/providers/Providers';
import { APP_NAME } from '@/lib/config';
import './globals.css';

export const metadata: Metadata = {
  title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#1f1b16' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-EC">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
