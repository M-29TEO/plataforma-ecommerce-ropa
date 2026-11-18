'use client';

import { PwaProvider } from '../pwa/PwaProvider';
import { AuthProvider } from './AuthProvider';
import { CartProvider } from './CartProvider';
import { ToastProvider } from './ToastProvider';
import { WishlistProvider } from './WishlistProvider';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <AuthProvider>
        <CartProvider>
          <WishlistProvider>
            <PwaProvider>{children}</PwaProvider>
          </WishlistProvider>
        </CartProvider>
      </AuthProvider>
    </ToastProvider>
  );
}
