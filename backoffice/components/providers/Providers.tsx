'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '@/lib/api/errors';
import { AuthProvider } from './AuthProvider';
import { ToastProvider } from './ToastProvider';

/**
 * TanStack Query: caché por pantalla con reintento solo ante fallas de red o 5xx (un 403 o un 422
 * no mejora reintentando). Los datos operativos se consideran viejos a los 15 s.
 */
function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: true,
        retry: (count, error) => count < 2 && !(error instanceof ApiError && error.status < 500),
      },
      mutations: { retry: false },
    },
  });
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(makeClient);
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <AuthProvider>{children}</AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
